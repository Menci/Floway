import type { GatewayCtx } from './gateway-ctx.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ChatTargetApi, PerformanceTelemetryContext, ModelCandidate } from '@floway-dev/provider';

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

// Pass-through wrapper around the upstream event stream. Task 10 will layer
// TTFT stamping on top of this.
export const withUpstreamTelemetry = <T>(
  events: AsyncIterable<ProtocolFrame<T>>,
  _ctx: GatewayCtx,
  _targetApi: ChatTargetApi,
): AsyncIterable<ProtocolFrame<T>> => {
  return (async function* () {
    for await (const frame of events) yield frame;
  })();
};
