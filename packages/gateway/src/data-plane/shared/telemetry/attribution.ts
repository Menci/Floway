import type { GatewayCtx } from '../../chat/shared/gateway-ctx.ts';
import { providerModelOf, type ModelCandidate, type PerformanceOperation, type PerformanceTelemetryContext, type TelemetryModelIdentity } from '@floway-dev/provider';

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

// `model` is the upstream-facing bare id (`candidate.model.id`,
// e.g. `gpt-4o`) regardless of which surface form the client called
// (`or/gpt-4o` or `gpt-4o`). Usage and performance aggregates therefore key on
// the canonical upstream id, and a dashboard slice over `model` rolls up both
// surfaces of the same upstream model under one row.
export const telemetryModelIdentity = (candidate: ModelCandidate, modelKey: string): TelemetryModelIdentity => ({
  model: candidate.model.id,
  upstream: candidate.provider.upstream,
  modelKey,
  pricing: providerModelOf(candidate).pricing ?? null,
});
