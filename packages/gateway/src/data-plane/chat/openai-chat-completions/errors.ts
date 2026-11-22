import { appendFailedUpstreams } from '../../shared/failed-upstreams.ts';
import { openAiErrorChatOutcome, type ChatAttemptOutcome } from '../pipeline/index.ts';
import type { ChatServeFailure, InputErrorDetails } from '../shared/errors.ts';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { PerformanceTelemetryContext } from '@floway-dev/provider';

// Validation failures retain the telemetry of the candidate whose attempt
// rejected the request.
export const inputErrorChatOutcome = (
  error: InputErrorDetails,
  performance?: PerformanceTelemetryContext,
): Extract<ChatAttemptOutcome<OpenAIChatCompletionsStreamEvent>, { type: 'api-error' }> =>
  openAiErrorChatOutcome(400, error.message, { param: error.param ?? 'messages', code: null }, performance);

export const renderOpenAIChatCompletionsFailure = (
  failure: ChatServeFailure,
): Extract<ChatAttemptOutcome<OpenAIChatCompletionsStreamEvent>, { type: 'api-error' }> => {
  switch (failure.kind) {
  case 'routing-unavailable':
    return openAiErrorChatOutcome(400, failure.message, { param: 'input', code: 'responses_item_routing_unavailable' });
  case 'model-missing':
    return openAiErrorChatOutcome(404, appendFailedUpstreams(
      `Model ${failure.model} is not available on any configured upstream.`,
      failure.failedUpstreams,
    ));
  case 'model-unsupported':
    return openAiErrorChatOutcome(400, appendFailedUpstreams(
      `Model ${failure.model} does not support the /chat/completions endpoint.`,
      failure.failedUpstreams,
    ));
  }
};
