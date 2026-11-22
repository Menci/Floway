import { appendFailedUpstreams } from '../../shared/failed-upstreams.ts';
import type { ChatAttemptOutcome } from '../pipeline/index.ts';
import { inputErrorFields, type ChatServeFailure, type InputErrorDetails } from '../shared/errors.ts';
import { generateAnthropicId, type AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ApiErrorResult, ExecuteResult, PerformanceTelemetryContext } from '@floway-dev/provider';

// Anthropic Messages error envelope used to render pre-stream
// `ChatServeFailure`s. These are gateway-synthesized rather than received
// from any upstream — `source: 'gateway'` so the dump labels them as such.
// Byte-shape matches Anthropic-direct: `{type:'error', error:{type, message},
// request_id}` with `request_id` at the top level (alongside `error`, not
// nested inside it) and key order load-bearing for byte-faithfulness.
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
  body: new TextEncoder().encode(JSON.stringify({
    type: 'error',
    error: { type, message, ...(extension === undefined ? {} : { provider_specific_fields: extension }) },
    request_id: generateAnthropicId('req'),
  })),
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

const anthropicMessagesApiErrorOutcome = (
  status: number,
  type: string,
  message: string,
): Extract<ChatAttemptOutcome<never>, { type: 'api-error' }> => ({
  type: 'api-error',
  source: 'gateway',
  http: {
    status,
    headers: Object.freeze([Object.freeze(['content-type', 'application/json'] as const)]),
  },
  body: new TextEncoder().encode(JSON.stringify({
    type: 'error',
    error: { type, message },
    request_id: generateAnthropicId('req'),
  })),
});

export const anthropicMessagesFailureOutcome = (
  failure: ChatServeFailure,
  endpoint: 'generate' | 'countTokens',
): Extract<ChatAttemptOutcome<never>, { type: 'api-error' }> => {
  const endpointPath = endpoint === 'countTokens' ? '/messages/count_tokens' : '/messages';
  switch (failure.kind) {
  case 'routing-unavailable':
    return anthropicMessagesApiErrorOutcome(400, 'invalid_request_error', failure.message);
  case 'model-missing':
    return anthropicMessagesApiErrorOutcome(404, 'not_found_error', appendFailedUpstreams(`Model ${failure.model} is not available on any configured upstream.`, failure.failedUpstreams));
  case 'model-unsupported':
    return anthropicMessagesApiErrorOutcome(400, 'invalid_request_error', appendFailedUpstreams(`Model ${failure.model} does not support the ${endpointPath} endpoint.`, failure.failedUpstreams));
  }
};

export const anthropicMessagesInputErrorOutcome = (
  error: InputErrorDetails,
): Extract<ChatAttemptOutcome<never>, { type: 'api-error' }> => ({
  type: 'api-error',
  source: 'gateway',
  http: {
    status: 400,
    headers: Object.freeze([Object.freeze(['content-type', 'application/json'] as const)]),
  },
  body: new TextEncoder().encode(JSON.stringify({
    type: 'error',
    error: {
      type: 'invalid_request_error',
      message: error.message,
      ...(inputErrorFields(error) === undefined ? {} : { provider_specific_fields: inputErrorFields(error) }),
    },
    request_id: generateAnthropicId('req'),
  })),
});
