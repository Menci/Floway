// Hosted backend calls have independent runs, timing and settlement. Their stage and stream
// ids belong to their own object space, so they never enter the parent turn's record.

import type { ServerToolLifecycleEvent, ServerToolTerminal } from './shim.ts';
import type { RunDump } from '../../../../dump/run-sink.ts';
import { consoleLogSink } from '../../../../runtime/log.ts';
import type { BillableEntity, GatewayFacts } from '../../../pipeline/facts.ts';
import type { StreamOutcome } from '../../../pipeline/serve.ts';
import { prologueFor } from '../../../pipeline/serve.ts';
import type { GatewayServices } from '../../../pipeline/services.ts';
import { settleBillable, writeSettlement } from '../../../pipeline/settlement.ts';
import type { AttemptState, GatewayCtx } from '../../../shared/gateway-ctx.ts';
import type { PerformanceTelemetryContext } from '../../../shared/telemetry/performance.ts';
import { compose, defer, defineStage, move, run, type Deferred, type Pipeline } from '@floway-dev/pipeline';
import { eventFrame } from '@floway-dev/protocols/common';

/** What one image call is, and what it comes to. */
export interface ImageSubRequestFacts extends GatewayFacts {
  'request.imageGeneration.action': 'generate' | 'edit';
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

type ImageCall = (settle: SettleImageCall) => AsyncGenerator<ServerToolLifecycleEvent, ServerToolTerminal>;
interface ImageServices extends GatewayServices { readonly imageCall: ImageCall }

const recordLifecycle = (source: AsyncGenerator<ServerToolLifecycleEvent, ServerToolTerminal>, dump: RunDump | null): AsyncGenerator<ServerToolLifecycleEvent, ServerToolTerminal> => {
  if (dump === null) return source;
  const recording = dump.openStream();
  const generator = (async function* () {
    let completed = false;
    try {
      for (;;) {
        const step = await source.next();
        recording.frame(eventFrame(step.value));
        if (step.done) {
          completed = true;
          recording.end();
          return step.value;
        }
        yield step.value;
      }
    } finally {
      if (!completed) await source.return(undefined as never);
    }
  })();
  return Object.assign(generator, recording.fact);
};

/**
 * The ending. It hands up the lifecycle the caller drives, and the reading that lifecycle
 * settles — the same shape every streaming family hands up, for the same reason: the numbers
 * arrive with the last event.
 */
const dialImageGeneration = defineStage<
  I<'request.imageGeneration.action'>,
  I<'response.imageGeneration.lifecycle' | 'response.imageGeneration.streamedUsage'> & { 'response.usage.billable': readonly BillableEntity[] },
  ImageServices
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
    return move({
      ...facts,
      'response.imageGeneration.lifecycle': recordLifecycle(use.imageCall((billable, failed, telemetry) => {
        // The sample is attributed to this run's own attempt slot, which is what keeps the
        // turn that asked for the image from having its upstream stamp overwritten.
        use.gateway.attempt.telemetry = telemetry;
        settle({ billable, failed });
      }), use.gateway.dump),
      'response.imageGeneration.streamedUsage': outcome,
      // Nothing has been reported when this hands up; what the call turns out to have cost
      // arrives through the reading above.
      'response.usage.billable': [],
    }) as never;
  },
});

const imageGenerationSubRequestPipeline: Pipeline<
  I<'request.imageGeneration.action'>,
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
  call: ImageCall,
): Promise<{
  readonly lifecycle: AsyncGenerator<ServerToolLifecycleEvent, ServerToolTerminal>;
  readonly drain: () => Promise<void>;
}> => {
  const path = action === 'edit' ? '/images/edits' : '/images/generations';
  const attempt: AttemptState = { timing: { firstOutputTokenAt: null, upstreamCallStartedAt: null }, telemetry: undefined };
  const dump = parent.dump?.openSubRequest({ method: 'POST', path }, false, attempt.timing) ?? null;
  const gateway: GatewayCtx = {
    ...parent,
    requestStartedAt: Date.now(),
    attempt,
    dump,
  };
  const prologue = prologueFor(gateway, { body: { bytes: new Uint8Array(), streamError: null }, headers: [] }, dump);

  const { facts, drain } = await run(
    imageGenerationSubRequestPipeline,
    move({ 'request.imageGeneration.action': action }) as never,
    { ...prologue.services, imageCall: call } as never,
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
