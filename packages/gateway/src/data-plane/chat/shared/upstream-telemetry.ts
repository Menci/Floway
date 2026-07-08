import { isFirstOutputTokenFrame } from './first-output-token.ts';
import type { GatewayCtx } from './gateway-ctx.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ChatTargetApi, ModelCandidate, PerformanceTelemetryContext } from '@floway-dev/provider';

// The full telemetry context for one upstream call: request-scoped dimensions
// (keyId, runtimeLocation) come off the gateway ctx, the model dimensions
// off the chosen candidate plus the upstream-reported model key.
export const upstreamPerformanceContext = (ctx: GatewayCtx, candidate: ModelCandidate, modelKey: string): PerformanceTelemetryContext => ({
  keyId: ctx.apiKeyId,
  model: candidate.model.id,
  upstream: candidate.provider.upstream,
  modelKey,
  runtimeLocation: ctx.runtimeLocation,
});

// Pipes the upstream event stream through, stamping
// `ctx.perfTiming.firstOutputTokenAt` the moment the first output-content
// frame arrives (thinking / reasoning / envelope frames don't count). This
// wrapper does not record any telemetry itself — the terminal-frame recorder
// owns that decision, using the stamped timestamp to compute TTFT and TPOT.
export const withUpstreamTelemetry = <T>(
  events: AsyncIterable<ProtocolFrame<T>>,
  ctx: GatewayCtx,
  targetApi: ChatTargetApi,
): AsyncIterable<ProtocolFrame<T>> => {
  return (async function* () {
    for await (const frame of events) {
      if (ctx.perfTiming.firstOutputTokenAt === null && isFirstOutputTokenFrame(frame, targetApi)) {
        ctx.perfTiming.firstOutputTokenAt = performance.now();
      }
      yield frame;
    }
  })();
};
