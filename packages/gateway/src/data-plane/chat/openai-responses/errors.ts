import { appendFailedUpstreams } from '../../shared/failed-upstreams.ts';
import { openAiErrorChatOutcome, type ChatAttemptOutcome } from '../pipeline/index.ts';
import type { ChatServeFailure, InputErrorDetails } from '../shared/errors.ts';
import type { OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import type { PerformanceTelemetryContext } from '@floway-dev/provider';

export type OpenAIResponsesServeFailure = ChatServeFailure | { readonly kind: 'item-not-found'; readonly itemId: string };

// Caller-input violations discovered by translation or the source affinity
// membrane share the OpenAI Responses 400 envelope. `performance` retains candidate
// attribution when validation fires after attempt dispatch.
export const inputErrorResult = (
  error: InputErrorDetails,
  performance?: PerformanceTelemetryContext,
): Extract<ChatAttemptOutcome<OpenAIResponsesStreamEventEx>, { type: 'api-error' }> =>
  openAiErrorChatOutcome(400, error.message, { param: error.param ?? 'input', code: error.code ?? null }, performance);

export const renderOpenAIResponsesFailure = (
  failure: OpenAIResponsesServeFailure,
): Extract<ChatAttemptOutcome<OpenAIResponsesStreamEventEx>, { type: 'api-error' }> => {
  switch (failure.kind) {
  case 'item-not-found':
    return openAiErrorChatOutcome(404, `Item with id '${failure.itemId}' not found.`, { param: 'input', code: null });
  case 'routing-unavailable':
    return openAiErrorChatOutcome(400, failure.message, { param: 'input', code: 'responses_item_routing_unavailable' });
  case 'model-missing':
    return openAiErrorChatOutcome(404, appendFailedUpstreams(`Model ${failure.model} is not available on any configured upstream.`, failure.failedUpstreams));
  case 'model-unsupported':
    return openAiErrorChatOutcome(400, appendFailedUpstreams(`Model ${failure.model} does not support the /responses endpoint.`, failure.failedUpstreams));
  }
};
