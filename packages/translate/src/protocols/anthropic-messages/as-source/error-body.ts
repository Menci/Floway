import { anthropicMessagesErrorEnvelope } from './error.ts';
import type { IRErrorPayload } from '../../../ir/output/error.ts';
import { irErrorPayloadFromBody, restateError } from '../../../shared/api-error.ts';
import type { ApiErrorTranslator } from '../../../types.ts';

export const writeAnthropicMessagesError = (upstreamStatus: number, headers: Headers, error: IRErrorPayload) => {
  const { body, status } = anthropicMessagesErrorEnvelope(error);
  return restateError(status ?? upstreamStatus, headers, body);
};

/** Reuse the stream error envelope for HTTP failures; unrecognized bodies remain verbatim upstream responses. */
export const restateAnthropicMessagesError: ApiErrorTranslator = (upstreamStatus, headers, upstreamBody) => {
  const error = irErrorPayloadFromBody(upstreamBody);
  return error === undefined ? undefined : writeAnthropicMessagesError(upstreamStatus, headers, error);
};
