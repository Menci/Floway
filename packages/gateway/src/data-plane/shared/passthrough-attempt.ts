// Per-candidate passthrough attempt: does the upstream HTTP call for one
// resolved candidate and hands the serve loop back a `plain`-shaped result
// the shared `iterateCandidates` iterator can drive.
//
// Chat protocols run each attempt through a translation + interceptor
// stack that yields an `ExecuteResult` discriminated union. Passthrough
// endpoints have no translation — the request body is forwarded to the
// upstream's matching endpoint and the raw upstream Response is returned
// verbatim. The `plain` discriminant is enlarged here to carry that
// Response plus the per-call telemetry the serve site needs when it
// forwards the winning attempt (2xx) or the last failure (exhausted).

import type { GatewayCtx } from './gateway-ctx.ts';
import { inboundHeaders } from './inbound-headers.ts';
import { telemetryModelIdentity, upstreamPerformanceContext } from './telemetry/attribution.ts';
import type { PerformanceTelemetryContext } from './telemetry/performance.ts';
import { buildUpstreamCallOptions } from './upstream-call-options.ts';
import type { AuthedContext } from '../../middleware/auth.ts';
import { providerModelOf } from '@floway-dev/provider';
import type { ModelCandidate, PerformanceOperation, Provider, ProviderCallResult, ProviderModel, TelemetryModelIdentity, UpstreamCallOptions } from '@floway-dev/provider';

// Enlarged `plain` shape: `iterateCandidates` reads `type` + `status`;
// the passthrough serve reads the rest to forward the response and
// attribute dumps. `identity` carries the upstream id alongside the
// model/pricing metadata the dump and usage-record paths already consume
// together.
export interface PassthroughAttemptResult {
  readonly type: 'plain';
  readonly status: number;
  readonly response: Response;
  readonly performance: PerformanceTelemetryContext;
  readonly identity: TelemetryModelIdentity;
}

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

// Statuses whose response is defined to carry no body; constructing a Response
// with one throws.
// https://fetch.spec.whatwg.org/#null-body-status
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

// The fallback loop keeps only the most recent failure and drops the rest, and
// on the direct-connect egress a dropped response strands its socket — the
// transport is released only when the body is read to its end or cancelled.
// Reading a failed attempt's body now makes the result inert, so no later owner
// has to remember to release it. The bytes, status and headers still forward
// verbatim when this turns out to be the last candidate. This is what the chat
// path already does through `readUpstreamApiError`.
const materializeFailure = async (response: Response): Promise<Response> => {
  const bytes = await response.arrayBuffer();
  return new Response(NULL_BODY_STATUSES.has(response.status) ? null : bytes, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};

export const passthroughAttempt = async (args: PassthroughAttemptArgs): Promise<PassthroughAttemptResult> => {
  const { c, ctx, candidate, operation, call } = args;
  const { response, modelKey } = await call(
    candidate.provider,
    providerModelOf(candidate),
    buildUpstreamCallOptions(candidate, ctx, inboundHeaders(c)),
  );
  return {
    type: 'plain',
    status: response.status,
    response: response.ok ? response : await materializeFailure(response),
    performance: upstreamPerformanceContext(ctx, candidate, operation),
    identity: telemetryModelIdentity(candidate, modelKey),
  };
};
