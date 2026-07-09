import { isFirstOutputTokenFrame } from './first-output-token.ts';
import type { GatewayCtx } from './gateway-ctx.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ChatTargetApi, ModelCandidate, PerformanceOperation, PerformanceTelemetryContext } from '@floway-dev/provider';

export const upstreamPerformanceContext = (
  ctx: GatewayCtx,
  candidate: ModelCandidate,
  modelKey: string,
  operation: PerformanceOperation,
): PerformanceTelemetryContext => ({
  keyId: ctx.apiKeyId,
  model: candidate.model.id,
  upstream: candidate.provider.upstream,
  operation,
  modelKey,
  runtimeLocation: ctx.runtimeLocation,
});

// Thinking, reasoning, and envelope frames are excluded; the terminal-frame
// recorder uses firstOutputTokenAt to compute TTFT and TPOT.
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
