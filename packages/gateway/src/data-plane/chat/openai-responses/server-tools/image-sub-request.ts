// The image the shim generates, as a run of its own.
//
// Ruling 2-and-6: a server tool's backend call is not part of the turn that asked for it — it is
// an independent run, with its own prologue, its own settlement and its own record. Its stages
// number from 1 like any run's, which is why the record has to be its own: events landing in the
// parent's would collide with the parent's ids and read as one turn entering a stage twice.
//
// What the ending does is unchanged — resolve the pinned image model, dial it with the rate-limit
// retry the hosted tool needs, and produce the lifecycle events the caller splices. What changes
// is where its cost lands: the reading it settles is the one `writeSettlement` writes both rows
// from, so a shim call bills through the same seam every other upstream call does rather than
// through two hand-rolled telemetry calls beside it.

import type { ServerToolLifecycleEvent, ServerToolTerminal } from './shim.ts';
import { consoleLogSink } from '../../../../runtime/log.ts';
import type { BillableEntity, GatewayFacts } from '../../../pipeline/facts.ts';
import type { StreamOutcome } from '../../../pipeline/serve.ts';
import { prologueFor } from '../../../pipeline/serve.ts';
import type { GatewayServices } from '../../../pipeline/services.ts';
import { settleBillable, writeSettlement } from '../../../pipeline/settlement.ts';
import type { GatewayCtx } from '../../../shared/gateway-ctx.ts';
import type { PerformanceTelemetryContext } from '../../../shared/telemetry/performance.ts';
import { compose, defer, defineStage, move, run, type Deferred, type Pipeline } from '@floway-dev/pipeline';

/** What one image call is, and what it comes to. */
export interface ImageSubRequestFacts extends GatewayFacts {
  /** The call, already planned: everything the ending needs to dial and nothing about the turn
   *  that asked for it. */
  'request.imageGeneration.call': (settle: SettleImageCall) => AsyncGenerator<ServerToolLifecycleEvent, ServerToolTerminal>;
  /** The lifecycle the caller splices into its own answer. */
  'response.imageGeneration.lifecycle': AsyncGenerator<ServerToolLifecycleEvent, ServerToolTerminal>;
  /** What the call turned out to cost, once its events have run out — which is after this run
   *  has answered, because the caller is what drives them. */
  'response.imageGeneration.streamedUsage': Deferred<StreamOutcome> | null;
}

type I<K extends keyof ImageSubRequestFacts> = { [P in K]: ImageSubRequestFacts[P] };

/** How the ending reports what it did, once it knows. The identity and the counts arrive with
 *  the backend's own response, long after this run handed up. */
export type SettleImageCall = (billable: readonly BillableEntity[], failed: boolean, telemetry: PerformanceTelemetryContext | undefined) => void;

/**
 * The ending. It hands up the lifecycle the caller drives, and the reading that lifecycle
 * settles — the same shape every streaming family hands up, for the same reason: the numbers
 * arrive with the last event.
 */
const dialImageGeneration = defineStage<
  I<'request.imageGeneration.call'>,
  I<'response.imageGeneration.lifecycle' | 'response.imageGeneration.streamedUsage'> & { 'response.usage.billable': readonly BillableEntity[] },
  GatewayServices
>({
  name: 'dialImageGeneration',
  return: {
    provides: ['response.imageGeneration.lifecycle', 'response.imageGeneration.streamedUsage', 'response.usage.billable'],
  },
  execute: async (facts, use) => {
    let settle!: (outcome: StreamOutcome) => void;
    // Declared as this run's own unfinished work, so the runner waits for it at teardown where
    // it can see it rather than the reading being started and forgotten.
    const outcome = defer(new Promise<StreamOutcome>(resolve => { settle = resolve; }));
    const call = facts['request.imageGeneration.call'];
    return move({
      ...facts,
      'response.imageGeneration.lifecycle': call((billable, failed, telemetry) => {
        // The sample is attributed to this run's own attempt slot, which is what keeps the
        // turn that asked for the image from having its upstream stamp overwritten.
        use.gateway.attempt.telemetry = telemetry;
        settle({ billable, failed });
      }),
      'response.imageGeneration.streamedUsage': outcome,
      // Nothing has been reported when this hands up; what the call turns out to have cost
      // arrives through the reading above.
      'response.usage.billable': [],
    }) as never;
  },
});

export const imageGenerationSubRequestPipeline: Pipeline<
  I<'request.imageGeneration.call'>,
  I<'response.imageGeneration.lifecycle' | 'response.imageGeneration.streamedUsage'>
> = compose('imageGenerationSubRequest', [
  writeSettlement(
    () => false,
    handedUp => (handedUp as { 'response.imageGeneration.streamedUsage'?: unknown })['response.imageGeneration.streamedUsage'] !== null,
  ),
  dialImageGeneration,
]);

/**
 * The run a shim call is.
 *
 * Its context is the parent's, with the three things a separate run owes itself: a start time of
 * its own, an attempt slot of its own — so the outer turn's upstream stamp survives — and a
 * record of its own.
 */
export const runImageGenerationSubRequest = async (
  parent: GatewayCtx,
  action: 'generate' | 'edit',
  call: ImageSubRequestFacts['request.imageGeneration.call'],
): Promise<{
  readonly lifecycle: AsyncGenerator<ServerToolLifecycleEvent, ServerToolTerminal>;
  readonly drain: () => Promise<void>;
}> => {
  const path = action === 'edit' ? '/images/edits' : '/images/generations';
  const dump = parent.dump?.openSubRequest({ method: 'POST', path }) ?? null;
  const gateway: GatewayCtx = {
    ...parent,
    requestStartedAt: Date.now(),
    attempt: { firstOutputTokenAt: null, upstreamCallStartedAt: null, telemetry: undefined },
    dump,
  };
  const prologue = prologueFor(gateway, { body: { bytes: new Uint8Array(), streamError: null }, headers: [] }, dump);

  const { facts, drain } = await run(
    imageGenerationSubRequestPipeline,
    move({ 'request.imageGeneration.call': call }) as never,
    prologue.services as never,
  );
  return {
    lifecycle: facts['response.imageGeneration.lifecycle'],
    // The epilogue a served turn gets from the seam, which a sub-request has to be its own: the
    // reading resolves when the lifecycle runs out, which is after this run answered, so the row
    // is written here rather than in the chain.
    drain: async () => {
      const reading = facts['response.imageGeneration.streamedUsage'];
      if (reading !== null) {
        const outcome = await reading;
        settleBillable({ ...prologue.services, log: consoleLogSink }, outcome.billable, outcome.failed);
      }
      await drain();
      dump?.finalize(200, 0);
    },
  };
};
