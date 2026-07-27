import { appendFailedUpstreams } from '../../shared/failed-upstreams.ts';
import { openAiErrorResult, type ChatServeFailure } from '../shared/errors.ts';
import type { ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ExecuteResult, PerformanceTelemetryContext } from '@floway-dev/provider';
import type { TranslatorInputError } from '@floway-dev/translate';

// Translator surfaced a caller-input violation. Render as a 400
// invalid_request_error so the caller sees a protocol-shaped failure
// instead of the internal-error 502 envelope. `param` falls back to
// `messages` (the Chat Completions canonical messages field) when the
// translator did not carry a more specific path. `performance` carries the
// throwing candidate's telemetry attribution when the throw fired
// mid-attempt (see AttemptState.telemetry).
export const translatorInputErrorResult = (
  error: TranslatorInputError,
  performance?: PerformanceTelemetryContext,
): ExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>> =>
  openAiErrorResult(400, error.message, { param: error.param ?? 'messages', code: null }, performance);

export const renderChatCompletionsFailure = (
  failure: ChatServeFailure,
): ExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>> => {
  switch (failure.kind) {
  case 'routing-unavailable':
    return openAiErrorResult(400, failure.message, { param: 'input', code: 'responses_item_routing_unavailable' });
  case 'model-missing':
    return openAiErrorResult(404, appendFailedUpstreams(`Model ${failure.model} is not available on any configured upstream.`, failure.failedUpstreams));
  case 'model-unsupported':
    return openAiErrorResult(400, appendFailedUpstreams(`Model ${failure.model} does not support the /chat/completions endpoint.`, failure.failedUpstreams));
  }
};
