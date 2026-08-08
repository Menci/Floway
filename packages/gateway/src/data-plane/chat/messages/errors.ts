import { appendFailedUpstreams } from '../../shared/failed-upstreams.ts';
import type { ChatServeFailure } from '../shared/errors.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { generateAnthropicId, type MessagesStreamEvent } from '@floway-dev/protocols/messages';
import type { ExecuteResult, PerformanceTelemetryContext } from '@floway-dev/provider';
import type { TranslatorInputError } from '@floway-dev/translate';

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
): ExecuteResult<ProtocolFrame<MessagesStreamEvent>> => ({
  type: 'api-error',
  source: 'gateway',
  status,
  headers: new Headers({ 'content-type': 'application/json' }),
  body: new TextEncoder().encode(JSON.stringify({
    type: 'error',
    error: { type, message },
    request_id: generateAnthropicId('req'),
  })),
  ...(performance ? { performance } : {}),
});

// Translator surfaced a caller-input violation (unsupported content part,
// disallowed role, missing required field, etc.). Render as a 400
// invalid_request_error so the caller sees a protocol-shaped failure
// instead of the internal-error 502 envelope. `performance` carries the
// throwing candidate's telemetry attribution when the throw fired
// mid-attempt (see AttemptState.telemetry).
export const translatorInputErrorResult = (
  error: TranslatorInputError,
  performance?: PerformanceTelemetryContext,
): ExecuteResult<ProtocolFrame<MessagesStreamEvent>> =>
  anthropicErrorResult(400, 'invalid_request_error', error.message, performance);

// `endpoint` selects between `/messages` and `/messages/count_tokens` only in
// the `model-unsupported` message string.
export const renderMessagesFailure = (
  failure: ChatServeFailure,
  endpoint: 'generate' | 'countTokens',
): ExecuteResult<ProtocolFrame<MessagesStreamEvent>> => {
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
