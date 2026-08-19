// The search a shim runs, as a run of its own.
//
// Ruling 2-and-6: a server tool's backend call is not part of the turn that asked for it — it is
// an independent run, with its own prologue, its own settlement and its own record. Its stages
// number from 1 like any run's, which is why the record has to be its own: events landing in the
// parent's would collide with the parent's ids and read as one turn entering a stage twice.
//
// A search settles differently from an image, and the difference is real rather than an
// omission. What the search backend charges is accounted per api key in units no model prices,
// so this run bills no entity — the row it writes names none, which is the settlement stage's
// own statement that a run which measured rather than generated still writes. And no
// `PerformanceOperation` names search, so there is no sample for the performance half to land on.
// What the run buys, then, is the record: a search that ran inside a turn is legible as its own.

import type { GatewayFacts } from '../../../pipeline/facts.ts';
import { prologueFor } from '../../../pipeline/serve.ts';
import type { GatewayServices } from '../../../pipeline/services.ts';
import { writeSettlement } from '../../../pipeline/settlement.ts';
import type { GatewayCtx } from '../../../shared/gateway-ctx.ts';
import type { WebSearchCallIR } from '../../../tools/web-search/operations.ts';
import { compose, defineStage, move, run, type Pipeline } from '@floway-dev/pipeline';

/** What one search call is, and what it came to. */
export interface WebSearchSubRequestFacts extends GatewayFacts {
  /** The call, already planned: the operations to run and nothing about the turn that asked. */
  'request.webSearch.call': () => Promise<WebSearchCallIR>;
  /** What the backend answered, in the shape the hosted-tool item is built from. */
  'response.webSearch.ir': WebSearchCallIR;
}

type W<K extends keyof WebSearchSubRequestFacts> = { [P in K]: WebSearchSubRequestFacts[P] };

const runWebSearchCall = defineStage<
  W<'request.webSearch.call'>,
  W<'response.webSearch.ir'> & { 'response.usage.billable': readonly never[] },
  GatewayServices
>({
  name: 'runWebSearchCall',
  return: { provides: ['response.webSearch.ir', 'response.usage.billable'] },
  execute: async facts => move({
    ...facts,
    'response.webSearch.ir': await facts['request.webSearch.call'](),
    // No model was called, so there is no entity to bill: what the backend charges is accounted
    // per api key by the operations as they run.
    'response.usage.billable': [],
  }) as never,
});

export const webSearchSubRequestPipeline: Pipeline<W<'request.webSearch.call'>, W<'response.webSearch.ir'>> =
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
  call: WebSearchSubRequestFacts['request.webSearch.call'],
): Promise<WebSearchCallIR> => {
  const dump = parent.dump?.openSubRequest({ method: 'POST', path: '/alpha/search' }) ?? null;
  const gateway: GatewayCtx = {
    ...parent,
    requestStartedAt: Date.now(),
    attempt: { firstOutputTokenAt: null, upstreamCallStartedAt: null, telemetry: undefined },
    dump,
  };
  const prologue = prologueFor(gateway, { body: { bytes: new Uint8Array(), streamError: null }, headers: [] }, dump);

  const { facts, drain } = await run(
    webSearchSubRequestPipeline,
    move({ 'request.webSearch.call': call }) as never,
    prologue.services as never,
  );
  // Nothing streams out of a search, so the run is over the moment it answers.
  await drain();
  dump?.finalize(200, 0);
  return facts['response.webSearch.ir'];
};
