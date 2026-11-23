import { appendFailedUpstreams } from '../../shared/failed-upstreams.ts';
import { inputErrorFields, type ChatServeFailure, type InputErrorDetails } from '../shared/errors.ts';
import { generateAnthropicId, type AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { type ApiErrorResult, type ExecuteResult, internalDebugErrorFields, type PerformanceTelemetryContext, toInternalDebugError } from '@floway-dev/provider';

export const internalAnthropicMessagesErrorPayload = (cause: unknown) => {
  const error = toInternalDebugError(cause);
  return {
    type: 'error',
    error: {
      type: error.type,
      message: error.message,
      provider_specific_fields: internalDebugErrorFields(error),
    },
  };
};

// Anthropic Messages error envelope used to render pre-stream
// `ChatServeFailure`s. These are gateway-synthesized rather than received
// from any upstream — `source: 'gateway'` so the dump labels them as such.
// Byte-shape matches Anthropic-direct: `{type:'error', error:{type, message},
// request_id}` with `request_id` at the top level (alongside `error`, not
// nested inside it) and key order load-bearing for byte-faithfulness.
export const anthropicMessagesErrorBody = (type: string, message: string, extension?: Record<string, unknown>) => ({
  type: 'error',
  error: { type, message, ...(extension === undefined ? {} : { provider_specific_fields: extension }) },
  request_id: generateAnthropicId('req'),
});

export const anthropicMessagesInputErrorBody = (error: InputErrorDetails) =>
  anthropicMessagesErrorBody('invalid_request_error', error.message, inputErrorFields(error));

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
  body: new TextEncoder().encode(JSON.stringify(anthropicMessagesErrorBody(type, message, extension))),
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
    return anthropicErrorResult(404, 'not_found_error', appendFailedUpstreams(`Model ${failure.model} is not available on any configured upstream.`, failure.failedUpstreams));
  case 'model-unsupported':
    return anthropicErrorResult(400, 'invalid_request_error', appendFailedUpstreams(`Model ${failure.model} does not support the ${endpointPath} endpoint.`, failure.failedUpstreams));
  }
};
