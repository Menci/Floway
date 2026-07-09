import { isFirstGeneratedTokenFrame } from './first-generated-token.ts';
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

export const withUpstreamTelemetry = <T>(
  events: AsyncIterable<ProtocolFrame<T>>,
  ctx: GatewayCtx,
  targetApi: ChatTargetApi,
): AsyncIterable<ProtocolFrame<T>> => {
  return (async function* () {
    for await (const frame of events) {
      if (ctx.perfTiming.firstGeneratedTokenAt === null && isFirstGeneratedTokenFrame(frame, targetApi)) {
        ctx.perfTiming.firstGeneratedTokenAt = performance.now();
      }
      yield frame;
    }
  })();
};
