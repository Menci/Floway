import { webSearchSubRequestPipeline } from './search-sub-request/pipeline.ts';
import type { SearchCall } from './search-sub-request/services.ts';
import { prologueFor } from '../../../pipeline/serve.ts';
import type { GatewayCtx, AttemptState } from '../../../shared/gateway-ctx.ts';
import type { WebSearchCallIR } from '../../../tools/web-search/operations.ts';
import { run, move } from '@floway-dev/pipeline';

/**
 * The run a shim's search is.
 *
 * Its context is the parent's, with the three things a separate run owes itself: a start time of
 * its own, an attempt slot of its own — so the outer turn's upstream stamp survives — and a
 * record of its own.
 */
export const runWebSearchSubRequest = async (
  parent: GatewayCtx,
  call: SearchCall,
): Promise<WebSearchCallIR> => {
  const attempt: AttemptState = { timing: { firstOutputTokenAt: null, upstreamCallStartedAt: null }, telemetry: undefined };
  const dump = parent.dump?.openSubRequest({ method: 'POST', path: '/alpha/search' }, false, attempt.timing) ?? null;
  const gateway: GatewayCtx = {
    ...parent,
    requestStartedAt: Date.now(),
    attempt,
    dump,
  };
  const prologue = prologueFor(gateway, { body: { bytes: new Uint8Array(), streamError: null }, headers: [] }, dump);

  const { facts, drain } = await run(
    webSearchSubRequestPipeline,
    move({ 'request.webSearch.action': 'search' }) as never,
    { ...prologue.services, searchCall: call } as never,
  );
  // Nothing streams out of a search, so the run is over the moment it answers.
  await drain();
  dump?.finalize(200, 0);
  return facts['response.webSearch.ir'];
};
