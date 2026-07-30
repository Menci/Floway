import { appendFailedUpstreams } from '../../shared/failed-upstreams.ts';
import { openAiErrorResult, type ChatServeFailure } from '../shared/errors.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import type { ApiErrorResult, ExecuteResult, PerformanceTelemetryContext } from '@floway-dev/provider';

export type ResponsesServeFailure = ChatServeFailure | { readonly kind: 'item-not-found'; readonly itemId: string };

// Caller-input violations discovered by translation or the source affinity
// membrane share the Responses 400 envelope. `performance` retains candidate
// attribution when validation fires after attempt dispatch.
export const responsesInputErrorResult = (
  error: { readonly message: string; readonly param?: string; readonly code?: string },
  performance?: PerformanceTelemetryContext,
): ApiErrorResult =>
  openAiErrorResult(400, error.message, { param: error.param ?? 'input', code: error.code ?? null }, performance);

export const renderResponsesFailure = (
  failure: ResponsesServeFailure,
): ExecuteResult<ProtocolFrame<ResponsesStreamEvent>> => {
  switch (failure.kind) {
  case 'item-not-found':
    return openAiErrorResult(404, `Item with id '${failure.itemId}' not found.`, { param: 'input', code: null });
  case 'routing-unavailable':
    return openAiErrorResult(400, failure.message, { param: 'input', code: 'responses_item_routing_unavailable' });
  case 'model-missing':
    return openAiErrorResult(404, appendFailedUpstreams(`Model ${failure.model} is not available on any configured upstream.`, failure.failedUpstreams));
  case 'model-unsupported':
    return openAiErrorResult(400, appendFailedUpstreams(`Model ${failure.model} does not support the /responses endpoint.`, failure.failedUpstreams));
  }
};
