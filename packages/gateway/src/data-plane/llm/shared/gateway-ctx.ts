import type { Context } from 'hono';

import { effectiveUpstreamIdsFromContext } from '../../../middleware/auth.ts';
import { backgroundSchedulerFromContext } from '../../../runtime/background.ts';
import { runtimeLocationFromRequest } from '../../shared/telemetry/performance.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';

export interface GatewayCtx {
  readonly apiKeyId: string;
  readonly upstreamIds: readonly string[] | null;
  readonly abortSignal?: AbortSignal;
  readonly wantsStream: boolean;
  readonly downstreamAbortController?: AbortController;
  readonly backgroundScheduler: BackgroundScheduler;
  // Stamped at ctx construction so request-total latency telemetry can subtract
  // from `performance.now()` at response completion.
  readonly requestStartedAt: number;
  // The deployment colo / region, recorded as the `runtimeLocation` performance
  // dimension. Request-scoped, so it is resolved once here rather than at the
  // provider-call boundary.
  readonly runtimeLocation: string;
}

export const createGatewayCtxFromHono = (c: Context, wantsStream: boolean): GatewayCtx => {
  const apiKeyId = c.get('apiKeyId') as string;
  const upstreamIds = effectiveUpstreamIdsFromContext(c);
  const downstreamAbortController = wantsStream ? new AbortController() : undefined;
  return {
    apiKeyId,
    upstreamIds,
    ...(downstreamAbortController !== undefined ? { abortSignal: downstreamAbortController.signal, downstreamAbortController } : {}),
    wantsStream,
    backgroundScheduler: backgroundSchedulerFromContext(c),
    requestStartedAt: performance.now(),
    runtimeLocation: runtimeLocationFromRequest(c.req.raw),
  };
};

export const createGatewayCtxForWs = (
  c: Context,
  downstreamAbortController: AbortController,
): GatewayCtx => {
  const apiKeyId = c.get('apiKeyId') as string;
  const upstreamIds = effectiveUpstreamIdsFromContext(c);
  return {
    apiKeyId,
    upstreamIds,
    abortSignal: downstreamAbortController.signal,
    wantsStream: true,
    downstreamAbortController,
    backgroundScheduler: backgroundSchedulerFromContext(c),
    requestStartedAt: performance.now(),
    runtimeLocation: runtimeLocationFromRequest(c.req.raw),
  };
};
