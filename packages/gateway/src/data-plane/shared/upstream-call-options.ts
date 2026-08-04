import type { GatewayCtx } from './gateway-ctx.ts';
import { stampUpstreamCallStart } from './gateway-ctx.ts';
import { filterInboundHeadersForProvider } from './inbound-headers.ts';
import type { ModelCandidate, ProviderCall, UpstreamCallOptions } from '@floway-dev/provider';

// See UpstreamCallOptions in `@floway-dev/provider` for the contract on each
// field, especially header ownership.
export const buildUpstreamCallOptions = (
  candidate: ModelCandidate,
  ctx: GatewayCtx,
  headers: Headers,
  call: ProviderCall,
): UpstreamCallOptions => ({
  fetcher: candidate.fetcher,
  waitUntil: ctx.backgroundScheduler,
  headers: filterInboundHeadersForProvider(headers, candidate.provider.kind, call),
  wrapUpstreamCall: stampUpstreamCallStart(ctx.attempt),
});
