import { openAIChatError } from '../pipeline/local-answer.ts';
import type { ChatRoutingFailure, InputErrorDetails } from '../shared/errors.ts';

export const invalidOpenAIResponsesRequest = (error: InputErrorDetails) =>
  openAIChatError(400, error.message, { param: error.param ?? 'input', code: error.code ?? null });

export const renderOpenAIResponsesFailure = (failure: ChatRoutingFailure) => {
  switch (failure.kind) {
  case 'routing-unavailable':
    return openAIChatError(400, failure.message, { param: 'input', code: 'responses_item_routing_unavailable' });
  case 'model-missing':
    return openAIChatError(404, `Model ${failure.model} is not available on any configured upstream.`);
  case 'model-unsupported':
    return openAIChatError(400, `Model ${failure.model} does not support the /responses endpoint.`);
  }
};
