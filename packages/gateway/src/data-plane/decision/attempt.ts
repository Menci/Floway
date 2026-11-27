import type { Context } from 'hono';

import type { GatewayCtx } from '../shared/gateway-ctx.ts';
import { inboundHeaders } from '../shared/inbound-headers.ts';
import type { RawAttemptResult } from '../shared/raw-attempt-result.ts';
import { telemetryModelIdentity, upstreamPerformanceContext } from '../shared/telemetry/attribution.ts';
import { buildUpstreamCallOptions } from '../shared/upstream-call-options.ts';
import type { DecisionTarget } from '@floway-dev/protocols/common';
import type { CanonicalDecisionRequest } from '@floway-dev/protocols/decision';
import type { ModelCandidate, UpstreamDecisionCallResult } from '@floway-dev/upstream';

export interface DecisionAttemptResult extends RawAttemptResult {
  readonly target: DecisionTarget;
}

export const decisionAttempt = async (
  c: Context,
  ctx: GatewayCtx,
  candidate: ModelCandidate,
  request: CanonicalDecisionRequest,
): Promise<DecisionAttemptResult> => {
  const model = candidate.model;
  const result: UpstreamDecisionCallResult = await candidate.upstream.instance.callDecision(
    model,
    request,
    ctx.abortSignal,
    buildUpstreamCallOptions(candidate, ctx, inboundHeaders(c)),
  );
  return {
    type: 'response',
    http: result.http,
    target: result.target,
    performance: upstreamPerformanceContext(ctx, candidate, 'decision'),
    identity: telemetryModelIdentity(candidate, result.modelKey),
  };
};
