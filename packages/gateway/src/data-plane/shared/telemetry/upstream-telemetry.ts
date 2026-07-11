import { isFirstOutputTokenFrame } from '../../chat/shared/first-output-token.ts';
import type { GatewayCtx } from '../../chat/shared/gateway-ctx.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ChatTargetApi, ModelCandidate, PerformanceOperation, PerformanceTelemetryContext } from '@floway-dev/provider';

export const upstreamPerformanceContext = (
  ctx: GatewayCtx,
  candidate: ModelCandidate,
  operation: PerformanceOperation,
): PerformanceTelemetryContext => ({
  keyId: ctx.apiKeyId,
  model: candidate.model.id,
  upstream: candidate.provider.upstream,
  operation,
  runtimeLocation: ctx.runtimeLocation,
});

export const withUpstreamTelemetry = <T>(
  events: AsyncIterable<ProtocolFrame<T>>,
  ctx: GatewayCtx,
  targetApi: ChatTargetApi,
): AsyncIterable<ProtocolFrame<T>> => {
  return (async function* () {
    for await (const frame of events) {
      if (ctx.attempt.firstOutputTokenAt === null && isFirstOutputTokenFrame(frame, targetApi)) {
        ctx.attempt.firstOutputTokenAt = performance.now();
      }
      yield frame;
    }
  })();
};
