// Per-candidate passthrough attempt: does the upstream HTTP call for one
// resolved candidate, records the upstream_success perf metric (success
// or failure), and hands the serve loop back a `plain`-shaped result the
// shared `iterateCandidates` iterator can drive.
//
// Chat protocols run each attempt through a translation + interceptor
// stack that yields an `ExecuteResult` discriminated union. Passthrough
// endpoints have no translation — the request body is forwarded to the
// upstream's matching endpoint and the raw upstream Response is returned
// verbatim. The `plain` discriminant is enlarged here to carry that
// Response plus the per-call telemetry the serve site needs when it
// forwards the winning attempt (2xx) or the last failure (exhausted).

import { inboundHeadersForUpstream } from './inbound-headers.ts';
import type { PerformanceTelemetryContext } from './telemetry/performance.ts';
import { createUpstreamLatencyRecorder, recordPerformanceError, recordPerformanceLatency, requireRecordedDurationMs } from './telemetry/performance.ts';
import type { AuthedContext } from '../../middleware/auth.ts';
import type { GatewayCtx } from '../chat/shared/gateway-ctx.ts';
import { providerModelOf } from '@floway-dev/provider';
import type { ModelCandidate, Provider, ProviderCallResult, ProviderModel, TelemetryModelIdentity, UpstreamCallOptions } from '@floway-dev/provider';

// Enlarged `plain` shape: `iterateCandidates` reads `type` + `status`;
// the passthrough serve reads the rest to forward the response, attribute
// dumps, and record request-total perf. `identity` carries the upstream
// id alongside the model/pricing metadata the dump and usage-record
// paths already consume together.
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
  // `true` when the passthrough serves an SSE stream (completions); flows
  // through to `PerformanceTelemetryContext.stream` so per-model latency
  // charts stay split by streaming vs one-shot semantics.
  readonly stream: boolean;
  // Performs the upstream HTTP call for the chosen (provider, model) pair.
  // Delegated to the passthrough caller so each endpoint keeps its
  // request-body shaping (`{ model: _, ...body }`) local. Any throw here
  // is preserved and the serve layer turns it into a 502 with the
  // internal-debug envelope. `model` is the emitting upstream's `ProviderModel`.
  readonly call: (provider: Provider, model: ProviderModel, opts: UpstreamCallOptions) => Promise<ProviderCallResult>;
}

export const passthroughAttempt = async (args: PassthroughAttemptArgs): Promise<PassthroughAttemptResult> => {
  const { c, ctx, candidate, stream, call } = args;
  const recorder = createUpstreamLatencyRecorder();
  const { response, modelKey } = await call(candidate.provider, providerModelOf(candidate), {
    fetcher: candidate.fetcher,
    recordUpstreamLatency: recorder.record,
    waitUntil: ctx.backgroundScheduler,
    headers: inboundHeadersForUpstream(c),
  });
  const upstreamDurationMs = requireRecordedDurationMs(recorder, 'passthrough upstream call');
  // Telemetry keys on the upstream's bare catalog id (`model.id`); the
  // user-facing error body echoes the inbound `model` and is the serve
  // layer's job.
  const identity: TelemetryModelIdentity = {
    model: candidate.model.id,
    upstream: candidate.provider.upstream,
    modelKey,
    cost: candidate.provider.instance.getPricingForModelKey(modelKey),
  };
  const performance: PerformanceTelemetryContext = {
    keyId: ctx.apiKeyId,
    model: identity.model,
    upstream: identity.upstream,
    modelKey: identity.modelKey,
    stream,
    runtimeLocation: ctx.runtimeLocation,
  };
  // Upstream-perf is recorded per attempt so the dashboard shows each
  // attempted upstream; request-perf and the dump's upstream attribution
  // wait until the serve loop picks its terminal candidate (2xx success
  // or last failure on exhaustion).
  ctx.backgroundScheduler(response.ok
    ? recordPerformanceLatency(performance, 'upstream_success', upstreamDurationMs)
    : recordPerformanceError(performance, 'upstream_success'));
  return {
    type: 'plain',
    status: response.status,
    response,
    performance,
    identity,
  };
};
