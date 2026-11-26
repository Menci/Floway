import type { Context } from 'hono';

import type { GatewayCtx } from '../shared/gateway-ctx.ts';
import { inboundHeaders } from '../shared/inbound-headers.ts';
import type { RawAttemptResult } from '../shared/raw-attempt-result.ts';
import { telemetryModelIdentity, upstreamPerformanceContext } from '../shared/telemetry/attribution.ts';
import { buildUpstreamCallOptions } from '../shared/upstream-call-options.ts';
import type { RerankTarget } from '@floway-dev/protocols/common';
import type { CanonicalRerankRequest } from '@floway-dev/protocols/rerank';
import type { ModelCandidate, UpstreamRerankCallResult } from '@floway-dev/upstream';

export interface RerankAttemptResult extends RawAttemptResult {
  readonly target: RerankTarget;
}

export const rerankAttempt = async (
  c: Context,
  ctx: GatewayCtx,
  candidate: ModelCandidate,
  request: CanonicalRerankRequest,
): Promise<RerankAttemptResult> => {
  const model = candidate.model;
  const result: UpstreamRerankCallResult = await candidate.upstream.instance.callRerank(
    model,
    request,
    ctx.abortSignal,
    buildUpstreamCallOptions(candidate, ctx, inboundHeaders(c)),
  );
  return {
    type: 'response',
    http: result.http,
    target: result.target,
    performance: upstreamPerformanceContext(ctx, candidate, 'rerank'),
    identity: telemetryModelIdentity(candidate, result.modelKey),
  };
};
