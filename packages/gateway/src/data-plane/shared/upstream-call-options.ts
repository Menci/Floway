import type { GatewayCtx } from './gateway-ctx.ts';
import { stampUpstreamCallStart } from './gateway-ctx.ts';
import { filterInboundHeadersForProvider } from './inbound-headers.ts';
import { retainUpstreamFetcher } from './retained-response.ts';
import type { ModelCandidate, UpstreamCallOptions } from '@floway-dev/provider';

// See UpstreamCallOptions in `@floway-dev/provider` for the contract on each
// field, especially header ownership.
export const buildUpstreamCallOptions = (
  candidate: ModelCandidate,
  ctx: GatewayCtx,
  headers: Headers,
): UpstreamCallOptions => ({
  fetcher: retainUpstreamFetcher(candidate.fetcher, ctx.clientDisconnectSignal, ctx.backgroundScheduler),
  waitUntil: ctx.backgroundScheduler,
  headers: filterInboundHeadersForProvider(headers, candidate.provider),
  wrapUpstreamCall: stampUpstreamCallStart(ctx.attempt, ctx.clientDisconnectSignal),
});
