import { isFirstOutputTokenFrame } from './first-output-token.ts';
import type { GatewayCtx } from './gateway-ctx.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ChatTargetApi, ModelCandidate, PerformanceTelemetryContext } from '@floway-dev/provider';

export const upstreamPerformanceContext = (ctx: GatewayCtx, candidate: ModelCandidate, modelKey: string): PerformanceTelemetryContext => ({
  keyId: ctx.apiKeyId,
  model: candidate.model.id,
  upstream: candidate.provider.upstream,
  modelKey,
  runtimeLocation: ctx.runtimeLocation,
});

// First output-content frame (thinking / reasoning / envelope frames don't
// count) stamps ctx.perfTiming.firstOutputTokenAt; the terminal-frame
// recorder uses that timestamp to compute TTFT and TPOT.
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
