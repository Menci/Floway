import { anthropicMessagesErrorEnvelope } from './sse-to.ts';
import { irErrorPayloadFromBody, restateError } from '../../../shared/api-error.ts';
import type { ApiErrorTranslator } from '../../../types.ts';

export const restateAnthropicMessagesError: ApiErrorTranslator = (upstreamStatus, headers, upstreamBody) => {
  const error = irErrorPayloadFromBody(upstreamBody);
  if (error === undefined) return undefined;
  const { body, status } = anthropicMessagesErrorEnvelope(error);
  return restateError(status ?? upstreamStatus, headers, body);
};
