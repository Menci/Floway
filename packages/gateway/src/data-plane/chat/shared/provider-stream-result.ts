import { firstOutputTokenSignal } from './first-output-token.ts';
import { observeStreamPrefix } from './observe-stream-prefix.ts';
import type { GatewayCtx } from '../../shared/gateway-ctx.ts';
import { telemetryModelIdentity, upstreamPerformanceContext } from '../../shared/telemetry/attribution.ts';
import type { BillableUsage, ProtocolFrame } from '@floway-dev/protocols/common';
import { eventResult, readUpstreamApiError, type ChatTargetApi, type EventResultMetadata, type ExecuteResult, type ModelCandidate, type ProviderStreamResult } from '@floway-dev/provider';

export const providerStreamResultToExecuteResult = async <TEvent>(
  providerResult: ProviderStreamResult<TEvent>,
  candidate: ModelCandidate,
  targetApi: ChatTargetApi,
  ctx: GatewayCtx,
  // Reads the upstream's own usage off one of its events, in the upstream's
  // own protocol. This is the only place pricing figures are produced; nothing
  // downstream re-derives them from the translated result the client receives.
  readBillableUsage: (event: TEvent) => BillableUsage | null,
): Promise<ExecuteResult<ProtocolFrame<TEvent>>> => {
  const context = upstreamPerformanceContext(ctx, candidate, 'chat');
  if (!providerResult.ok) {
    return { ...(await readUpstreamApiError(providerResult.response, candidate.provider.upstreamId)), performance: context };
  }
  const identity = telemetryModelIdentity(candidate, providerResult.modelKey);
  let resolveFinal!: (metadata: EventResultMetadata) => void;
  const finalMetadata = new Promise<EventResultMetadata>(resolve => { resolveFinal = resolve; });
  // Only a report carrying real counts replaces the running figure, so a
  // trailing empty usage frame cannot wipe a good one. Held outside the
  // stream iterator so an abandoned stream can still settle with what it saw.
  let billableUsage: BillableUsage | undefined;
  const settleMetadata = (): void => {
    ctx.abortSignal?.removeEventListener('abort', settleMetadata);
    resolveFinal({
      modelIdentity: identity,
      ...(context !== undefined ? { performance: context } : {}),
      ...(billableUsage !== undefined ? { billableUsage } : {}),
    });
  };
  // Every streaming response now resolves its cost here, and the respond
  // layer awaits it in a `finally`. A transport that walks away without
  // closing the generator would otherwise hang that await forever, so the
  // abort settles it too; whichever fires first wins, and the later call is a
  // no-op.
  ctx.abortSignal?.addEventListener('abort', settleMetadata, { once: true });
  // Provider normalization determines when a frame crosses this observation
  // boundary. Its internal buffering remains included in the measurement.
  const stampedEvents = observeStreamPrefix(providerResult.events, frame => {
    if (!ctx.abortSignal?.aborted && !ctx.attempt.outputObservationUnavailable && ctx.attempt.timing.firstOutputTokenAt === null) {
      const signal = firstOutputTokenSignal(frame, targetApi);
      if (signal !== null) {
        ctx.attempt.timing.firstOutputTokenAt = performance.now();
        if (signal.type === 'runtime-output') {
          console.warn('Floway: first output timing started from runtime output without an earlier decode signal in this response', {
            outputType: signal.outputType,
            upstream: identity.upstream,
            model: identity.model,
            modelKey: identity.modelKey,
          });
        }
      }
    }
    if (frame.type === 'event') {
      const reported = readBillableUsage(frame.event);
      if (reported !== null) billableUsage = reported;
    }
    return ctx.attempt.timing.firstOutputTokenAt !== null || ctx.attempt.outputObservationUnavailable;
  }, () => {
    ctx.attempt.outputObservationUnavailable = true;
    console.warn('Floway: first output timing unavailable because the observation prefix reached its buffer limit', {
      upstream: identity.upstream, model: identity.model, modelKey: identity.modelKey,
    });
  }, settleMetadata, () => { ctx.downstreamAbortController?.abort(); });
  return {
    ...eventResult(stampedEvents, identity, { performance: context, headers: providerResult.headers }),
    finalMetadata,
  };
};
