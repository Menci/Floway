import type { GatewayCtx } from './gateway-ctx.ts';
import { inboundHeaders } from './inbound-headers.ts';
import type { RawAttemptResult } from './raw-attempt-result.ts';
import { telemetryModelIdentity, upstreamPerformanceContext } from './telemetry/attribution.ts';
import { buildUpstreamCallOptions } from './upstream-call-options.ts';
import type { AuthedContext } from '../../middleware/auth.ts';
import type { ModelCandidate, PerformanceOperation, Upstream, UpstreamCallResult, UpstreamModel, UpstreamCallOptions } from '@floway-dev/upstream';

export interface PassthroughAttemptArgs {
  readonly c: AuthedContext;
  readonly ctx: GatewayCtx;
  readonly candidate: ModelCandidate;
  readonly operation: PerformanceOperation;
  // Delegated to the passthrough caller so each endpoint keeps its
  // request-body shaping (`{ model: _, ...body }`) local. Any throw here
  // is preserved and the serve layer turns it into a 502 with the
  // internal-debug envelope.
  readonly call: (upstream: Upstream, model: UpstreamModel, opts: UpstreamCallOptions) => Promise<UpstreamCallResult>;
}

export const passthroughAttempt = async (args: PassthroughAttemptArgs): Promise<RawAttemptResult> => {
  const { c, ctx, candidate, operation, call } = args;
  const { http: response, modelKey } = await call(
    candidate.upstream,
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
