import { imageGenerationSubRequestPipeline } from './image-sub-request/pipeline.ts';
import type { ImageCall } from './image-sub-request/services.ts';
import type { HostedToolLifecycleEvent, HostedToolTerminal } from './types.ts';
import { consoleLogSink } from '../../../../runtime/log.ts';
import { prologueFor } from '../../../pipeline/serve.ts';
import { settleBillable } from '../../../pipeline/settlement.ts';
import type { GatewayCtx, AttemptState } from '../../../shared/gateway-ctx.ts';
import { run, move } from '@floway-dev/pipeline';

/**
 * The run a dispatcher call is.
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
  readonly lifecycle: AsyncGenerator<HostedToolLifecycleEvent, HostedToolTerminal>;
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
