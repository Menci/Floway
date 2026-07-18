import { appendFailedUpstreams } from '../../shared/failed-upstreams.ts';
import type { ChatServeFailure } from '../shared/errors.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import type { ExecuteResult, PerformanceTelemetryContext } from '@floway-dev/provider';

// OpenAI error envelope. `param` / `code` reproduce OpenAI's native fields; a
// stored-item miss must byte-match OpenAI's own "not found" body — stateless
// clients (codex) compare the whole body verbatim. The envelope is
// gateway-synthesized — `source: 'gateway'` so the dump labels it as such.
const openAiErrorResult = (
  status: number,
  message: string,
  extra?: { readonly param: string; readonly code: string | null },
  performance?: PerformanceTelemetryContext,
): ExecuteResult<ProtocolFrame<ResponsesStreamEvent>> => ({
  type: 'api-error',
  source: 'gateway',
  status,
  headers: new Headers({ 'content-type': 'application/json' }),
  body: new TextEncoder().encode(JSON.stringify({
    error: { message, type: 'invalid_request_error', ...extra },
  })),
  ...(performance ? { performance } : {}),
});

// Caller-input violations discovered by translation or the source affinity
// membrane share the Responses 400 envelope. `performance` retains candidate
// attribution when validation fires after attempt dispatch.
export const responsesInputErrorResult = (
  error: { readonly message: string; readonly param?: string },
  performance?: PerformanceTelemetryContext,
): ExecuteResult<ProtocolFrame<ResponsesStreamEvent>> =>
  openAiErrorResult(400, error.message, { param: error.param ?? 'input', code: null }, performance);

export const renderResponsesFailure = (
  failure: ChatServeFailure,
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
