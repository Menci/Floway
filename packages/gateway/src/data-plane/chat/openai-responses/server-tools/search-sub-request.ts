// Search backends run independently from the hosted-tool turn. The operations account for
// their own API-key charges; the run records the search result without inventing model usage.

import type { GatewayFacts } from '../../../pipeline/facts.ts';
import { prologueFor } from '../../../pipeline/serve.ts';
import type { GatewayServices } from '../../../pipeline/services.ts';
import { writeSettlement } from '../../../pipeline/settlement.ts';
import type { AttemptState, GatewayCtx } from '../../../shared/gateway-ctx.ts';
import type { WebSearchCallIR } from '../../../tools/web-search/operations.ts';
import { compose, defineStage, move, run, type Pipeline } from '@floway-dev/pipeline';

/** What one search call is, and what it came to. */
export interface WebSearchSubRequestFacts extends GatewayFacts {
  'request.webSearch.action': 'search';
  /** What the backend answered, in the shape the hosted-tool item is built from. */
  'response.webSearch.ir': WebSearchCallIR;
}

type W<K extends keyof WebSearchSubRequestFacts> = { [P in K]: WebSearchSubRequestFacts[P] };

type SearchCall = () => Promise<WebSearchCallIR>;
interface SearchServices extends GatewayServices { readonly searchCall: SearchCall }

const runWebSearchCall = defineStage<
  W<'request.webSearch.action'>,
  W<'response.webSearch.ir'> & { 'response.usage.billable': readonly never[] },
  SearchServices
>({
  name: 'runWebSearchCall',
  return: { provides: ['response.webSearch.ir', 'response.usage.billable'] },
  execute: async (facts, use) => move({
    ...facts,
    'response.webSearch.ir': await use.searchCall(),
    // No model was called, so there is no entity to bill: what the backend charges is accounted
    // per api key by the operations as they run.
    'response.usage.billable': [],
  }) as never,
});

const webSearchSubRequestPipeline: Pipeline<W<'request.webSearch.action'>, W<'response.webSearch.ir'>> =
  compose('webSearchSubRequest', [
    writeSettlement(() => false),
    runWebSearchCall,
  ]);

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
