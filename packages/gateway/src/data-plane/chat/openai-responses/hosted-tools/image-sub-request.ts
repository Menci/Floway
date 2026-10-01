import { imageGenerationSubRequestPipeline } from './image-sub-request/pipeline.ts';
import type { ImageGenerationRequest } from './image-sub-request/request.ts';
import type { HostedToolLifecycleEvent, HostedToolTerminal } from './types.ts';
import { prologueFor } from '../../../pipeline/serve.ts';
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
  request: ImageGenerationRequest,
): Promise<{
  readonly lifecycle: AsyncGenerator<HostedToolLifecycleEvent, HostedToolTerminal>;
  readonly drain: () => Promise<void>;
}> => {
  const path = request.action === 'edit' ? '/images/edits' : '/images/generations';
  const attempt: AttemptState = { timing: { firstOutputTokenAt: null, upstreamCallStartedAt: null }, telemetry: undefined };
  const wantsStream = (request.config.partial_images ?? 0) > 0;
  const dump = parent.dump?.openSubRequest({ method: 'POST', path }, wantsStream, attempt.timing) ?? null;
  const gateway: GatewayCtx = {
    ...parent,
    wantsStream,
    requestStartedAt: Date.now(),
    attempt,
    dump,
  };
  const prologue = prologueFor(gateway, { body: { bytes: new Uint8Array(), streamError: null }, headers: [] }, dump);

  try {
    const { facts, drain } = await run(
      imageGenerationSubRequestPipeline(request),
      move({ 'request.imageGeneration.canonical': request, 'ingress.http.headers': [] }),
      { ...prologue.services },
    );
    prologue.runDump?.afterRun(drain);
    return {
      lifecycle: facts['response.imageGeneration.lifecycle'],
      drain: async () => {
        let status = facts['response.http.status'];
        try {
          // Releasing the native body also drives an unread image to its usage terminal.
          // Waiting for that reading first would prevent the owner from ever starting it.
          await drain();
        } catch (error) {
          dump?.failed(error);
          if ((await facts['response.imageGeneration.lifecycleOutcome']).kind === 'exception') status = 500;
          throw error;
        } finally {
          dump?.finalize(status, 0);
        }
      },
    };
  } catch (error) {
    dump?.failed(error);
    dump?.finalize(500, 0);
    throw error;
  }
};
