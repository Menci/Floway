import { inputErrorFields, type ChatServeFailure, type InputErrorDetails } from '../shared/errors.ts';
import { generateAnthropicId, type AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ApiErrorResult, ExecuteResult, PerformanceTelemetryContext } from '@floway-dev/upstream';

// https://platform.claude.com/docs/en/api/errors#http-errors
export const anthropicErrorTypeForStatus = (status: number): string => {
  switch (status) {
  case 400: return 'invalid_request_error';
  case 401: return 'authentication_error';
  case 403: return 'permission_error';
  case 404: return 'not_found_error';
  case 429: return 'rate_limit_error';
  case 529: return 'overloaded_error';
  default: return 'api_error';
  }
};

// Byte-shape matches Anthropic-direct: `{type:'error', error:{type, message},
// request_id}` with `request_id` at the top level (alongside `error`, not
// nested inside it) and key order load-bearing for byte-faithfulness.
export const anthropicErrorEnvelopeBody = (
  type: string,
  message: string,
  extension?: Record<string, unknown>,
): Uint8Array => new TextEncoder().encode(JSON.stringify({
  type: 'error',
  error: { type, message, ...(extension === undefined ? {} : { provider_specific_fields: extension }) },
  request_id: generateAnthropicId('req'),
}));

// Anthropic Messages error envelope used to render pre-stream `ChatServeFailure`s.
// These are gateway-synthesized (`source: 'gateway'`) so dumps label them as such.
const anthropicErrorResult = (
  status: number,
  type: string,
  message: string,
  performance?: PerformanceTelemetryContext,
  extension?: Record<string, unknown>,
): ApiErrorResult => ({
  type: 'api-error',
  source: 'gateway',
  http: { status, headers: new Headers({ 'content-type': 'application/json' }) },
  body: anthropicErrorEnvelopeBody(type, message, extension),
  ...(performance ? { performance } : {}),
});

// Validation failures retain the telemetry of the candidate whose attempt rejected the request.
export const inputErrorResult = (
  error: InputErrorDetails,
  performance?: PerformanceTelemetryContext,
): ApiErrorResult =>
  anthropicErrorResult(400, 'invalid_request_error', error.message, performance, inputErrorFields(error));

// `endpoint` selects between `/messages` and `/messages/count_tokens` only in
// the `model-unsupported` message string.
export const renderAnthropicMessagesFailure = (
  failure: ChatServeFailure,
  endpoint: 'generate' | 'countTokens',
): ExecuteResult<ProtocolFrame<AnthropicMessagesStreamEventEx>> => {
  const endpointPath = endpoint === 'countTokens' ? '/messages/count_tokens' : '/messages';
  switch (failure.kind) {
  case 'routing-unavailable':
    return anthropicErrorResult(400, 'invalid_request_error', failure.message);
  case 'model-missing':
    return anthropicErrorResult(404, 'not_found_error', `Model ${failure.model} is not available on any configured upstream.`);
  case 'model-unsupported':
    return anthropicErrorResult(400, 'invalid_request_error', `Model ${failure.model} does not support the ${endpointPath} endpoint.`);
  }
};
