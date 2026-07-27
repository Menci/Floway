import type { GatewayCtx } from '../gateway-ctx.ts';
import { providerModelOf, type ModelCandidate, type PerformanceOperation, type PerformanceTelemetryContext, type TelemetryModelIdentity } from '@floway-dev/provider';

export const upstreamPerformanceContext = (
  ctx: GatewayCtx,
  candidate: ModelCandidate,
  operation: PerformanceOperation,
): PerformanceTelemetryContext => ({
  keyId: ctx.apiKeyId,
  model: candidate.model.id,
  upstream: candidate.provider.upstreamId,
  operation,
  runtimeLocation: ctx.runtimeLocation,
});

// `model` is the public catalog id the candidate resolved under, before any
// per-upstream name prefix — the operator's `publicModelId` override when set,
// otherwise the id the upstream published. The genuinely upstream-facing value
// is `modelKey`, the id that went out on the wire. Usage and performance
// aggregates key on `model`, so a dashboard slice over it rolls up both the
// prefixed and the bare surface of the same model under one row.
export const telemetryModelIdentity = (candidate: ModelCandidate, modelKey: string): TelemetryModelIdentity => ({
  model: candidate.model.id,
  upstream: candidate.provider.upstreamId,
  modelKey,
  pricing: providerModelOf(candidate).pricing ?? null,
});
