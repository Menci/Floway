import type { GatewayCtx } from '../chat/shared/gateway-ctx.ts';
import { stampUpstreamCallStart } from '../chat/shared/gateway-ctx.ts';
import type { ModelCandidate, UpstreamCallOptions } from '@floway-dev/provider';

// See UpstreamCallOptions in `@floway-dev/provider` for the contract on each
// field, especially header ownership.
export const buildUpstreamCallOptions = (
  candidate: ModelCandidate,
  ctx: GatewayCtx,
  headers: Headers,
): UpstreamCallOptions => ({
  fetcher: candidate.fetcher,
  waitUntil: ctx.backgroundScheduler,
  headers,
  wrapUpstreamCall: stampUpstreamCallStart(ctx.attempt),
});
