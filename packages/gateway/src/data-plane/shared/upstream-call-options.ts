import { stampUpstreamCallStart } from './attempt-timing.ts';
import type { GatewayCtx } from './gateway-ctx.ts';
import { filterInboundHeadersForUpstream } from './inbound-headers.ts';
import type { ModelCandidate, UpstreamCallOptions } from '@floway-dev/upstream';

// See UpstreamCallOptions in `@floway-dev/upstream` for the contract on each
// field, especially header ownership.
export const buildUpstreamCallOptions = (
  candidate: ModelCandidate,
  ctx: GatewayCtx,
  headers: Headers,
): UpstreamCallOptions => ({
  fetcher: ctx.dump?.http.wrapFetcher(candidate.fetcher, candidate.upstream.upstreamId) ?? candidate.fetcher,
  waitUntil: ctx.backgroundScheduler,
  headers: filterInboundHeadersForUpstream(headers, candidate.upstream),
  wrapUpstreamCall: stampUpstreamCallStart(ctx.attempt.timing),
});
