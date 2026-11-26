import { type OpenAIResponsesDelivery } from './pipeline-facts.ts';
import { OPENAI_RESPONSES_REASONING_INCLUDED_HEADER, OPENAI_RESPONSES_REASONING_INCLUDED_VALUE } from './response-headers.ts';
import { openAIResponsesFailureEvents } from './stream-error.ts';
import { encode, jsonResponse, localResponseHead } from '../../pipeline/encode.ts';
import { MAX_CHAT_COLLECTION_BYTES } from '../shared/collect.ts';
import { chatSse } from '../shared/encode.ts';
import { setHeader } from '@floway-dev/http';
import { eventFrame, sseFrame } from '@floway-dev/protocols/common';
import {
  isOpenAIResponsesTerminalEvent,
  OPENAI_RESPONSES_MISSING_TERMINAL_MESSAGE,
  openaiResponsesProtocolFrameToSSEFrame,
  type OpenAIResponsesErrorEx,
  type OpenAIResponsesOutputItemEx,
  type OpenAIResponsesResultEx,
  type OpenAIResponsesStreamEventEx,
} from '@floway-dev/protocols/openai-responses';
import { internalDebugErrorFields, toInternalDebugError, type ProtocolStreamError } from '@floway-dev/provider';

// https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/src/specifications/2026-04-24.mdx#L82-L86
const done = sseFrame('[DONE]');
const frame = (event: OpenAIResponsesStreamEventEx) => openaiResponsesProtocolFrameToSSEFrame(eventFrame(event));
const textEncoder = new TextEncoder();

const responseSseFrames = () => {
  let announced: OpenAIResponsesResultEx | undefined;
  let terminal: OpenAIResponsesStreamEventEx | undefined;
  let nextSequence = 0;
  const completedItems = new Map<number, { item: OpenAIResponsesOutputItemEx; bytes: number }>();
  let completedBytes = 0;

  const failedTrailer = (failure: OpenAIResponsesErrorEx) => {
    if (announced === undefined) return [];
    // https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/src/specifications/2026-04-24.mdx#L419-L444
    const output = [...completedItems].toSorted(([left], [right]) => left - right).map(([, { item }]) => item);
    return [frame({
      type: 'response.failed',
      sequence_number: nextSequence++,
      response: { ...announced, status: 'failed', output, incomplete_details: null, error: failure },
    })];
  };

  const eventFrameWithSequence = (event: OpenAIResponsesStreamEventEx) => {
    const sequence = event.sequence_number ?? nextSequence;
    nextSequence = Math.max(nextSequence, sequence + 1);
    return frame({ ...event, sequence_number: sequence });
  };

  const failureFrames = (failure: ProtocolStreamError) => {
    const { notification, failed } = openAIResponsesFailureEvents(failure);
    if (failed) return notification ? [eventFrameWithSequence(notification), eventFrameWithSequence(failed)] : [eventFrameWithSequence(failed)];
    if (notification) {
      const { type: _type, sequence_number: _sequenceNumber, ...fields } = notification;
      const body = 'error' in fields ? fields.error : fields;
      return [eventFrameWithSequence(notification), ...failedTrailer({ ...body, code: body.code ?? 'server_error' })];
    }

    const { cause } = failure;
    const debug = toInternalDebugError(cause);
    const error: OpenAIResponsesErrorEx = {
      code: debug.type,
      message: debug.message,
      provider_specific_fields: internalDebugErrorFields(debug),
    };
    // https://github.com/openai/openai-node/blob/d77cf24d9f3885739c6cba76bc009abf0ab97428/src/core/streaming.ts#L69-L71
    return [frame({
      type: 'error', sequence_number: nextSequence++, code: error.code, message: error.message, param: null, error,
    }), ...failedTrailer(error)];
  };

  return {
    event(event: OpenAIResponsesStreamEventEx) {
      if (terminal !== undefined) return null;
      if (isOpenAIResponsesTerminalEvent(event)) {
        terminal = event;
        return null;
      }
      if ('response' in event) announced = event.response;
      if (event.type === 'response.output_item.done') {
        const bytes = textEncoder.encode(JSON.stringify(event.item)).byteLength;
        completedBytes += bytes - (completedItems.get(event.output_index)?.bytes ?? 0);
        if (completedBytes > MAX_CHAT_COLLECTION_BYTES) {
          throw new RangeError(`OpenAI Responses SSE failure output exceeds the ${MAX_CHAT_COLLECTION_BYTES}-byte limit`);
        }
        completedItems.set(event.output_index, { item: event.item, bytes });
      }
      return eventFrameWithSequence(event);
    },
    error: failureFrames,
    done: () => terminal === undefined
      ? failureFrames({ kind: 'protocol', cause: new Error(OPENAI_RESPONSES_MISSING_TERMINAL_MESSAGE) })
      : [eventFrameWithSequence(terminal), done],
  };
};

export const encodeOpenAIResponses = encode<'openaiResponses', OpenAIResponsesDelivery>(
  'openaiResponses',
  ({ http, outcome }, scope) => {
    if (outcome.kind === 'error') {
      return jsonResponse(http ?? localResponseHead(outcome.source === 'local' ? 499 : 502), outcome.error);
    }

    const head = http ?? localResponseHead(200);
    if (outcome.kind === 'result') {
      return jsonResponse({
        ...head,
        headers: setHeader(head.headers, OPENAI_RESPONSES_REASONING_INCLUDED_HEADER, OPENAI_RESPONSES_REASONING_INCLUDED_VALUE),
      }, outcome.result);
    }
    return chatSse(head, outcome.stream, scope, {
      ...responseSseFrames(),
      headers: [[OPENAI_RESPONSES_REASONING_INCLUDED_HEADER, OPENAI_RESPONSES_REASONING_INCLUDED_VALUE]],
    });
  },
  'request.delivery',
);
