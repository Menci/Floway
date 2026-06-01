import type { Context } from 'hono';

import { backgroundSchedulerFromContext } from '../../../runtime/background.ts';
import { runtimeLocationFromRequest } from '../../shared/telemetry/performance.ts';
import type { RequestContext } from '../interceptors.ts';

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
    statefulResponsesContext: { privatePayload: new Map(), newSyntheticIds: new Set() },
    ...(downstreamAbortSignal !== undefined ? { downstreamAbortSignal } : {}),
  };
};
