import type { WebSearchRequest } from './search-sub-request/facts.ts';
import { webSearchSubRequestPipeline } from './search-sub-request/pipeline.ts';
import type { WebSearchRuntime } from './search-sub-request/services.ts';
import { prologueFor } from '../../../pipeline/serve.ts';
import type { GatewayCtx, AttemptState } from '../../../shared/gateway-ctx.ts';
import type { WebSearchCallIR } from '../../../tools/web-search/operations.ts';
import { run, move } from '@floway-dev/pipeline';

/**
 * The run a dispatcher's search is.
 *
 * Its context is the parent's, with the three things a separate run owes itself: a start time of
 * its own, an attempt slot of its own — so the outer turn's upstream stamp survives — and a
 * record of its own.
 */
export const runWebSearchSubRequest = async (
  parent: GatewayCtx,
  request: WebSearchRequest,
  webSearch: WebSearchRuntime,
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

  try {
    const { facts, drain } = await run(
      webSearchSubRequestPipeline,
      move({ 'request.webSearch.canonical': request }),
      { ...prologue.services, webSearch },
    );
    prologue.runDump?.afterRun(drain);
    await drain();
    dump?.finalize(200, 0);
    return facts['response.webSearch.ir'];
  } catch (error) {
    dump?.failed(error);
    dump?.finalize(502, 0);
    throw error;
  }
};
