import { openAIResponsesFailureEvents } from './stream-error.ts';
import type { ChatCollectionFailure, ChatCollector } from '../shared/collect.ts';
import { isJsonObject } from '@floway-dev/protocols/common';
import {
  OPENAI_RESPONSES_MISSING_TERMINAL_MESSAGE,
  type OpenAIResponsesResultEx,
  type OpenAIResponsesStreamEventEx,
} from '@floway-dev/protocols/openai-responses';
import { internalDebugErrorFields, toInternalDebugError, type ProtocolStreamError } from '@floway-dev/provider';

type ErrorEvent = Extract<OpenAIResponsesStreamEventEx, { type: 'error' }>;

const errorHttpStatus = new Map([
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

// https://github.com/openai/openai-node/blob/b579bcb3e586d22269ffe6fe504653a0e05acbe8/src/core/error.ts#L60-L94
const statusFor = (event: ErrorEvent): number => {
  const { type: _type, sequence_number: _sequenceNumber, ...fields } = event;
  const payload: Record<string, unknown> = 'error' in fields && isJsonObject(fields.error) ? fields.error : fields;
  const details = isJsonObject(payload.provider_specific_fields) ? payload.provider_specific_fields : undefined;
  for (const classification of [payload.code, payload.type, details?.code, details?.type]) {
    if (typeof classification !== 'string') continue;
    const status = errorHttpStatus.get(classification);
    if (status !== undefined) return status;
  }
  return 502;
};

const eventFailure = (event: ErrorEvent): ChatCollectionFailure => {
  const { sequence_number: _sequenceNumber, ...error } = event;
  return { kind: 'error', source: 'upstream', error, status: statusFor(event) };
};

export const openAIResponsesStreamFailure = (failure: ProtocolStreamError): ChatCollectionFailure => {
  const { kind, cause } = failure;
  const { notification, failed } = openAIResponsesFailureEvents(failure);
  if (notification !== undefined) return eventFailure(notification);
  if (failed?.response.error != null) {
    return { kind: 'error', source: 'upstream', status: 502, error: { error: failed.response.error } };
  }
  const error = toInternalDebugError(cause);
  return {
    kind: 'error',
    source: kind === 'abort' ? 'local' : 'upstream',
    status: kind === 'abort' ? 499 : 502,
    error: { error: { type: error.type, message: error.message, provider_specific_fields: internalDebugErrorFields(error) } },
  };
};

export const collectOpenAIResponses = (): ChatCollector<'openaiResponses'> => {
  let result: OpenAIResponsesResultEx | undefined;

  return {
    push(event) {
      if (event.type === 'response.completed' || event.type === 'response.incomplete') result = event.response;
    },
    finish() {
      if (result !== undefined) return { kind: 'result', result };
      return openAIResponsesStreamFailure({ kind: 'protocol', cause: new Error(OPENAI_RESPONSES_MISSING_TERMINAL_MESSAGE) });
    },
  };
};
