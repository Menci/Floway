import type { Context } from 'hono';

import type { PerformanceApiName } from '../../../repo/types.ts';
import { backgroundSchedulerFromContext } from '../../../runtime/background.ts';
import type { NonLlmServeApiName } from '../../shared/api-names.ts';
import { type PerformanceTelemetryContext, runtimeLocationFromRequest } from '../../shared/telemetry/performance.ts';
import type { RequestContext } from '../interceptors.ts';
import { toInternalDebugError } from '../shared/errors/internal-debug-error.ts';
import { internalErrorResult, type ExecuteResult, type UpstreamErrorResult } from '../shared/errors/result.ts';
import { thrownUpstreamErrorResult } from '../shared/errors/upstream-error.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';

type PerformanceLlmSourceApi = Exclude<PerformanceApiName, NonLlmServeApiName>;

export const createRequestContext = (c: Context, downstreamAbortSignal: AbortSignal | undefined, clientStream: boolean): RequestContext => {
  const apiKeyId = c.get('apiKeyId') as string | undefined;
  const apiKeyUpstreamIds = c.get('apiKeyUpstreamIds') as readonly string[] | null | undefined;
  const scheduleBackground = backgroundSchedulerFromContext(c);

  return {
    requestStartedAt: performance.now(),
    apiKeyId,
    apiKeyUpstreamIds: apiKeyUpstreamIds ?? null,
    runtimeLocation: runtimeLocationFromRequest(c.req.raw),
    scheduleBackground,
    clientStream,
    ...(downstreamAbortSignal !== undefined ? { downstreamAbortSignal } : {}),
  };
};

export const jsonUpstreamErrorResult = (status: number, body: unknown, performance?: PerformanceTelemetryContext): UpstreamErrorResult => ({
  type: 'upstream-error',
  status,
  headers: new Headers({ 'content-type': 'application/json' }),
  body: new TextEncoder().encode(JSON.stringify(body)),
  ...(performance ? { performance } : {}),
});

const openAiModelErrorResult = (status: number, message: string) =>
  jsonUpstreamErrorResult(status, {
    error: { message, type: 'invalid_request_error' },
  });

export const openAiMissingModelResult = (model: string) => openAiModelErrorResult(404, `No upstream provides model ${model}. Configure an upstream that exposes this model in the dashboard.`);

export const openAiUnsupportedEndpointResult = (model: string, endpoint: string) => openAiModelErrorResult(400, `Model ${model} does not support the ${endpoint} endpoint.`);

export const sourceErrorResult = <TEvent>(
  error: unknown,
  options: {
    sourceApi: PerformanceLlmSourceApi;
    internalStatus: number;
  },
): ExecuteResult<ProtocolFrame<TEvent>> => {
  const upstreamError = thrownUpstreamErrorResult(error);
  if (upstreamError) return upstreamError;

  return internalErrorResult(options.internalStatus, toInternalDebugError(error, options.sourceApi));
};
