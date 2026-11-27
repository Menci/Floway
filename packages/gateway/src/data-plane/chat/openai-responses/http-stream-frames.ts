import { MAX_CHAT_COLLECTION_BYTES } from '../pipeline/collect.ts';
import { clientFrame, type StreamFrame } from '../pipeline/encode.ts';
import { openAIResponsesFailureEvents, openAIResponsesStreamErrorPayload } from '../pipeline/stream-error.ts';
import { doneFrame, eventFrame, sseFrame } from '@floway-dev/protocols/common';
import {
  isOpenAIResponsesErrorEvent,
  isOpenAIResponsesTerminalEvent,
  OPENAI_RESPONSES_MISSING_TERMINAL_MESSAGE,
  openaiResponsesProtocolFrameToSSEFrame,
  type OpenAIResponsesErrorEx,
  type OpenAIResponsesOutputItemEx,
  type OpenAIResponsesResultEx,
  type OpenAIResponsesStreamEventEx,
} from '@floway-dev/protocols/openai-responses';
import { internalDebugErrorFields, toInternalDebugError, type ProtocolStreamError } from '@floway-dev/upstream';

const encoder = new TextEncoder();
// https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/src/specifications/2026-04-24.mdx#L82-L86
const done: StreamFrame = { frame: doneFrame(), wire: sseFrame('[DONE]') };

export const openAIResponsesSseFrames = () => {
  let announced: Omit<OpenAIResponsesResultEx, 'output'> | undefined;
  let announcedBytes = 0;
  let terminal: OpenAIResponsesStreamEventEx | undefined;
  let nextSequence = 0;
  let deliveredTerminal = false;
  let deliveredError: OpenAIResponsesErrorEx | undefined;
  const completed = new Map<number, { item: OpenAIResponsesOutputItemEx; bytes: number }>();
  let completedBytes = 0;

  const requireCapacity = (bytes: number) => {
    if (bytes > MAX_CHAT_COLLECTION_BYTES) {
      throw new RangeError(`OpenAI Responses SSE retained output exceeds the ${MAX_CHAT_COLLECTION_BYTES}-byte limit`);
    }
  };

  const record = (event: OpenAIResponsesStreamEventEx): void => {
    if ('response' in event) {
      const { output: _output, ...snapshot } = event.response;
      const bytes = encoder.encode(JSON.stringify(snapshot)).byteLength;
      requireCapacity(bytes + completedBytes);
      announcedBytes = bytes;
      announced = snapshot;
    }
    if (event.type === 'response.output_item.done') {
      const bytes = encoder.encode(JSON.stringify(event.item)).byteLength;
      const nextBytes = completedBytes + bytes - (completed.get(event.output_index)?.bytes ?? 0);
      requireCapacity(announcedBytes + nextBytes);
      completedBytes = nextBytes;
      completed.set(event.output_index, { item: event.item, bytes });
    }
  };

  const frame = (event: OpenAIResponsesStreamEventEx): StreamFrame => {
    const sequenceNumber = event.sequence_number ?? nextSequence;
    nextSequence = Math.max(nextSequence, sequenceNumber + 1);
    const sequenced = { ...event, sequence_number: sequenceNumber };
    return clientFrame(sequenced, openaiResponsesProtocolFrameToSSEFrame(eventFrame(sequenced)));
  };

  const failedTrailer = (error: OpenAIResponsesErrorEx): readonly StreamFrame[] => {
    if (announced === undefined) return [done];
    // https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/src/specifications/2026-04-24.mdx#L419-L444
    const output = [...completed].toSorted(([left], [right]) => left - right).map(([, { item }]) => item);
    return [frame({
      type: 'response.failed',
      response: { ...announced, status: 'failed', output, incomplete_details: null, error },
    }), done];
  };

  const debugFrames = (cause: unknown): readonly StreamFrame[] => {
    const debug = toInternalDebugError(cause);
    const failure = { code: debug.type, message: debug.message, provider_specific_fields: internalDebugErrorFields(debug) };
    // https://github.com/openai/openai-node/blob/d77cf24d9f3885739c6cba76bc009abf0ab97428/src/core/streaming.ts#L69-L71
    return [frame({ type: 'error', code: failure.code, message: failure.message, param: null, error: failure }), ...failedTrailer(failure)];
  };

  const failureFrames = (error: ProtocolStreamError): readonly StreamFrame[] => {
    const { notification, failed } = openAIResponsesFailureEvents(error);
    if (failed !== undefined) return [...(notification === undefined ? [] : [frame(notification)]), frame(failed), done];
    if (notification === undefined) return debugFrames(error.cause);
    const payload = openAIResponsesStreamErrorPayload(notification);
    const code = typeof payload.code === 'string' ? payload.code : 'server_error';
    const message = typeof payload.message === 'string' ? payload.message : String(error.cause);
    return [frame(notification), ...failedTrailer({ ...payload, code, message })];
  };

  return {
    event(event: OpenAIResponsesStreamEventEx) {
      if (terminal !== undefined) return null;
      if (isOpenAIResponsesTerminalEvent(event)) {
        requireCapacity(announcedBytes + completedBytes + encoder.encode(JSON.stringify(event)).byteLength);
        terminal = event;
        return null;
      }
      record(event);
      return frame(event);
    },
    error: failureFrames,
    done: () => terminal === undefined
      ? debugFrames(new Error(OPENAI_RESPONSES_MISSING_TERMINAL_MESSAGE))
      : [frame(terminal), done],

    delivered(event: OpenAIResponsesStreamEventEx): void {
      if (event.sequence_number !== undefined) nextSequence = Math.max(nextSequence, event.sequence_number + 1);
      if (isOpenAIResponsesTerminalEvent(event)) {
        deliveredTerminal = true;
        return;
      }
      record(event);
      if (isOpenAIResponsesErrorEvent(event)) {
        const payload = openAIResponsesStreamErrorPayload(event);
        const code = typeof payload.code === 'string' ? payload.code : 'server_error';
        const message = typeof payload.message === 'string' ? payload.message : 'Upstream Responses stream failed';
        deliveredError = { ...payload, code, message };
      }
    },
    panic: (error: unknown) => deliveredTerminal ? undefined
      : deliveredError === undefined ? debugFrames(error) : failedTrailer(deliveredError),
  };
};
