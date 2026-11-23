import { completeOpenAIResponsesCompaction } from './compaction-resource.ts';
import { failedRender } from '../../pipeline/render.ts';
import { serializeSseFrame, type SseProtocol } from '../../shared/sse.ts';
import { createEncode, type DeliveryIntent } from '../shared/encode.ts';
import { eventFrame, isJsonObject, type ProtocolFrame, sseFrame } from '@floway-dev/protocols/common';
import {
  collectOpenAIResponsesProtocolEventsToResult,
  type ClientOpenAIResponsesStreamEvent,
  type ClientResponseResource,
  isOpenAIResponsesErrorEvent,
  isOpenAIResponsesTerminalEvent,
  OPENAI_RESPONSES_MISSING_TERMINAL_MESSAGE,
  openaiResponsesProtocolFrameToSSEFrame,
  type OpenAIResponsesErrorEx,
  type OpenAIResponsesStreamEventEx,
} from '@floway-dev/protocols/openai-responses';
import { internalDebugErrorFields, toInternalDebugError } from '@floway-dev/provider';

export interface ResponsesDelivery extends DeliveryIntent {
  readonly createdAt: number;
}

const ERROR_HTTP_STATUS = new Map<string, number>([
  ['invalid_request_error', 400],
  ['invalid_prompt', 400],
  ['authentication_error', 401],
  ['invalid_api_key', 401],
  ['permission_error', 403],
  ['not_found_error', 404],
  ['conflict_error', 409],
  ['unprocessable_entity_error', 422],
  ['rate_limit_error', 429],
  ['rate_limit_exceeded', 429],
  ['insufficient_quota', 429],
  ['server_error', 500],
  ['internal_error', 500],
]);

// OpenAI SDKs classify API failures by these HTTP categories.
// https://github.com/openai/openai-node/blob/b579bcb3e586d22269ffe6fe504653a0e05acbe8/src/core/error.ts#L60-L94
const openAIResponsesErrorHttpStatus = (event: Extract<OpenAIResponsesStreamEventEx, { type: 'error' }>): number => {
  const { type: _type, sequence_number: _sequenceNumber, ...fields } = event;
  const payload = ('error' in fields && isJsonObject(fields.error) ? fields.error : fields) as Readonly<Record<string, unknown>>;
  const details = isJsonObject(payload.provider_specific_fields) ? payload.provider_specific_fields : undefined;
  for (const classification of [payload.code, payload.type, details?.code, details?.type]) {
    if (typeof classification !== 'string') continue;
    const status = ERROR_HTTP_STATUS.get(classification);
    if (status !== undefined) return status;
  }
  return 502;
};

export const openAIResponsesInternalErrorBody = (error: unknown) => {
  const debug = toInternalDebugError(error);
  return { error: { type: debug.type, message: debug.message, provider_specific_fields: internalDebugErrorFields(debug) } };
};

export const collectFailure = (error: unknown) => {
  if (error instanceof Error && isOpenAIResponsesErrorEvent(error.cause)) {
    const { sequence_number: _sequenceNumber, ...body } = error.cause;
    return { status: openAIResponsesErrorHttpStatus(error.cause), body, reason: 'protocol-error' as const };
  }
  return { status: 502, body: openAIResponsesInternalErrorBody(error) };
};

const openaiResponsesSseProtocol = (): SseProtocol<ProtocolFrame<ClientOpenAIResponsesStreamEvent>> => {
  let announced: ClientResponseResource | undefined;
  let upstreamFailure: OpenAIResponsesErrorEx | undefined;
  let nextSequence = 0;
  const completedItems = new Map<number, ClientResponseResource['output'][number]>();
  // https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/src/specifications/2026-04-24.mdx#L82-L86
  const done = serializeSseFrame(sseFrame('[DONE]'));
  const emit = (event: ClientOpenAIResponsesStreamEvent) => {
    const frame = eventFrame(event);
    const wire = serializeSseFrame(openaiResponsesProtocolFrameToSSEFrame(frame));
    return wire;
  };
  const failedTrailer = (failure: OpenAIResponsesErrorEx) => {
    if (announced === undefined) return [done] as const;
    // https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/src/specifications/2026-04-24.mdx#L419-L444
    const output = [...completedItems].sort(([left], [right]) => left - right).map(([, item]) => item);
    return [emit({
      type: 'response.failed',
      sequence_number: nextSequence++,
      response: { ...announced, status: 'failed', output, incomplete_details: null, error: failure },
    }), done] as const;
  };
  const eof: SseProtocol<ProtocolFrame<ClientOpenAIResponsesStreamEvent>>['eof'] = () => upstreamFailure
    ? { type: 'protocol-error', trailer: failedTrailer(upstreamFailure) }
    : { type: 'premature-eof', error: new Error(OPENAI_RESPONSES_MISSING_TERMINAL_MESSAGE) };

  return {
    encode: frame => {
      if (frame.type === 'done') return { wire: null, end: eof() };
      const event = { ...frame.event, sequence_number: frame.event.sequence_number ?? nextSequence };
      const wire = serializeSseFrame(openaiResponsesProtocolFrameToSSEFrame(eventFrame(event)));
      nextSequence = Math.max(nextSequence, event.sequence_number + 1);
      if ('response' in event) announced = event.response;
      if (event.type === 'response.output_item.done') completedItems.set(event.output_index, event.item);
      if (isOpenAIResponsesErrorEvent(event)) {
        const { type: _type, sequence_number: _sequence, ...fields } = event;
        const error = 'error' in fields ? fields.error : fields;
        // The stream error permits a null code; a failed Response requires a code.
        // https://github.com/openai/openai-node/blob/d77cf24d9f3885739c6cba76bc009abf0ab97428/src/resources/responses/responses.ts
        upstreamFailure = { ...error, code: error.code ?? 'server_error' };
      }
      return isOpenAIResponsesTerminalEvent(event)
        ? { wire, end: { type: event.type === 'response.failed' || upstreamFailure ? 'protocol-error' : 'completed', trailer: [done] } }
        : { wire };
    },
    eof,
    failure: error => {
      if (upstreamFailure) return failedTrailer(upstreamFailure);
      const debug = toInternalDebugError(error);
      const failure: OpenAIResponsesErrorEx = { code: debug.type, message: debug.message, provider_specific_fields: internalDebugErrorFields(debug) };
      // SDKs raise on the nested payload; the Responses event also has native top-level fields.
      // https://github.com/openai/openai-node/blob/d77cf24d9f3885739c6cba76bc009abf0ab97428/src/core/streaming.ts#L69-L71
      return [emit({
        type: 'error', sequence_number: nextSequence++,
        code: failure.code, message: failure.message, param: null, error: failure,
      }), ...failedTrailer(failure)];
    },
  };
};

export const encodeResponses = createEncode<'openaiResponses', ResponsesDelivery, ClientOpenAIResponsesStreamEvent>('openaiResponses', {
  collectFailure,
  transportError: error => ({ status: 502, body: openAIResponsesInternalErrorBody(error) }),
  openSse: openaiResponsesSseProtocol,
  encodeJson: collectOpenAIResponsesProtocolEventsToResult,
  jsonOutcome: json => isJsonObject(json) && json.status === 'failed' ? failedRender('protocol-error') : { kind: 'completed' },
});

export const encodeResponsesCompact = createEncode<'openaiResponses', ResponsesDelivery, OpenAIResponsesStreamEventEx>('openaiResponses', {
  collectFailure,
  transportError: error => ({ status: 502, body: openAIResponsesInternalErrorBody(error) }),
  encodeScalar: (result, delivery) => completeOpenAIResponsesCompaction(result, delivery.createdAt),
  async encodeJson(source, delivery) {
    const result = await collectOpenAIResponsesProtocolEventsToResult(source);
    return completeOpenAIResponsesCompaction(result, delivery.createdAt);
  },
  jsonOutcome: json => isJsonObject(json) && json.status === 'failed' ? failedRender('protocol-error') : { kind: 'completed' },
});
