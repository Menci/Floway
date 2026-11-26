import { openAiErrorResult, type ChatServeFailure, type InputErrorDetails } from '../shared/errors.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { ExecuteResult, PerformanceTelemetryContext } from '@floway-dev/upstream';

// Validation failures retain the telemetry of the candidate whose attempt rejected the request.
export const inputErrorResult = (
  error: InputErrorDetails,
  performance?: PerformanceTelemetryContext,
): ExecuteResult<ProtocolFrame<OpenAIChatCompletionsStreamEvent>> =>
  openAiErrorResult(400, error.message, { param: error.param ?? 'messages', code: null }, performance);

export const renderOpenAIChatCompletionsFailure = (
  failure: ChatServeFailure,
): ExecuteResult<ProtocolFrame<OpenAIChatCompletionsStreamEvent>> => {
  switch (failure.kind) {
  case 'routing-unavailable':
    return openAiErrorResult(400, failure.message, { param: 'input', code: 'responses_item_routing_unavailable' });
  case 'model-missing':
    return openAiErrorResult(404, `Model ${failure.model} is not available on any configured upstream.`);
  case 'model-unsupported':
    return openAiErrorResult(400, `Model ${failure.model} does not support the /chat/completions endpoint.`);
  }
};
