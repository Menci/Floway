import type { GatewayCtx } from './gateway-ctx.ts';
import { stampUpstreamCallStart } from './gateway-ctx.ts';
import { filterInboundHeadersForProvider } from './inbound-headers.ts';
import { retainResponse } from './retained-response.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import type { Fetcher, ModelCandidate, UpstreamCallOptions } from '@floway-dev/provider';

export const retainUpstreamFetcher = (
  fetcher: Fetcher,
  clientDisconnectSignal: AbortSignal,
  backgroundScheduler: BackgroundScheduler,
): Fetcher => async (url, init) => {
  clientDisconnectSignal.throwIfAborted();
  const pendingResponse = fetcher(url, init);
  backgroundScheduler(pendingResponse.then(() => {}));
  return retainResponse(await pendingResponse, backgroundScheduler);
};

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
