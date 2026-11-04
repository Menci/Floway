import type { Context } from 'hono';

import type { GatewayCtx } from '../shared/gateway-ctx.ts';
import { inboundHeaders } from '../shared/inbound-headers.ts';
import { telemetryModelIdentity, upstreamPerformanceContext } from '../shared/telemetry/attribution.ts';
import { buildUpstreamCallOptions } from '../shared/upstream-call-options.ts';
import type { DecisionTarget } from '@floway-dev/protocols/common';
import type { CanonicalDecisionRequest } from '@floway-dev/protocols/decision';
import { providerModelOf } from '@floway-dev/provider';
import type { ModelCandidate, PerformanceTelemetryContext, ProviderDecisionCallResult, TelemetryModelIdentity } from '@floway-dev/provider';

export interface DecisionAttemptResult {
  readonly type: 'plain';
  readonly status: number;
  readonly response: Response;
  readonly target: DecisionTarget;
  readonly performance: PerformanceTelemetryContext;
  readonly identity: TelemetryModelIdentity;
}

export const decisionAttempt = async (
  c: Context,
  ctx: GatewayCtx,
  candidate: ModelCandidate,
  request: CanonicalDecisionRequest,
): Promise<DecisionAttemptResult> => {
  const model = providerModelOf(candidate);
  const result: ProviderDecisionCallResult = await candidate.provider.instance.callDecision(
    model,
    request,
    ctx.abortSignal,
    buildUpstreamCallOptions(candidate, ctx, inboundHeaders(c)),
  );
  return {
    type: 'plain',
    status: result.response.status,
    response: result.response,
    target: result.target,
    performance: upstreamPerformanceContext(ctx, candidate, 'decision'),
    identity: telemetryModelIdentity(candidate, result.modelKey),
  };
};
