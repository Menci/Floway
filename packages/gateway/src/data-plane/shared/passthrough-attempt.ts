import type { GatewayCtx } from './gateway-ctx.ts';
import { inboundHeaders } from './inbound-headers.ts';
import type { RawAttemptResult } from './raw-attempt-result.ts';
import { telemetryModelIdentity, upstreamPerformanceContext } from './telemetry/attribution.ts';
import { buildUpstreamCallOptions } from './upstream-call-options.ts';
import type { AuthedContext } from '../../middleware/auth.ts';
import type { ModelCandidate, PerformanceOperation, Provider, ProviderCallResult, ProviderModel, UpstreamCallOptions } from '@floway-dev/provider';

export interface PassthroughAttemptArgs {
  readonly c: AuthedContext;
  readonly ctx: GatewayCtx;
  readonly candidate: ModelCandidate;
  readonly operation: PerformanceOperation;
  // Delegated to the passthrough caller so each endpoint keeps its
  // request-body shaping (`{ model: _, ...body }`) local. Any throw here
  // is preserved and the serve layer turns it into a 502 with the
  // internal-debug envelope.
  readonly call: (provider: Provider, model: ProviderModel, opts: UpstreamCallOptions) => Promise<ProviderCallResult>;
}

export const passthroughAttempt = async (args: PassthroughAttemptArgs): Promise<RawAttemptResult> => {
  const { c, ctx, candidate, operation, call } = args;
  const { http: response, modelKey } = await call(
    candidate.provider,
    candidate.model,
    buildUpstreamCallOptions(candidate, ctx, inboundHeaders(c)),
  );
  return {
    type: 'response',
    http: response,
    performance: upstreamPerformanceContext(ctx, candidate, operation),
    identity: telemetryModelIdentity(candidate, modelKey),
  };
};
