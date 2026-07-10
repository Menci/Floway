import { currentHour } from './hour.ts';
import { getRepo } from '../../../repo/index.ts';
import type { PerformanceDimensions } from '../../../repo/types.ts';
import type { GatewayCtx, PerfTiming } from '../../chat/shared/gateway-ctx.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import type { PerformanceTelemetryContext } from '@floway-dev/provider';

export type { PerformanceTelemetryContext };

const record = async (op: Promise<void>, label: string): Promise<void> => {
  try {
    await op;
  } catch (error) {
    console.warn(`Failed to record performance ${label}:`, error);
  }
};

const dimensions = (telemetry: PerformanceTelemetryContext): PerformanceDimensions => ({
  hour: currentHour(),
  keyId: telemetry.keyId,
  model: telemetry.model,
  upstream: telemetry.upstream,
  operation: telemetry.operation,
  runtimeLocation: telemetry.runtimeLocation,
});

const recordError = (dims: PerformanceDimensions): Promise<void> =>
  record(getRepo().performance.recordError(dims), 'error');

// TTFT is measured from the provider's outbound-fetch stamp so it isolates
// upstream round-trip latency from gateway-internal overhead. Any success
// without a real upstream call or first-output-token stamp records as
// neutral; only genuine upstream failures land in the error bucket. TPOT
// layers on top only when at least two output tokens streamed — see the
// per-branch comments below.
export const recordRequestPerformance = (
  scheduler: BackgroundScheduler,
  perfTiming: PerfTiming,
  telemetry: PerformanceTelemetryContext | undefined,
  failed: boolean,
  outputTokens: number,
  requestFinishedAt: number,
): void => {
  if (!telemetry) return;
  if (outputTokens < 0) throw new Error(`recordRequestPerformance: negative outputTokens=${outputTokens}`);
  const dims = dimensions(telemetry);
  if (failed) {
    scheduler(recordError(dims));
    return;
  }
  if (
    telemetry.operation !== 'chat' ||
    perfTiming.upstreamCallStartedAt === null ||
    perfTiming.firstOutputTokenAt === null
  ) {
    scheduler(record(getRepo().performance.recordNeutral(dims), 'neutral'));
    return;
  }
  const ttftMs = Math.round(perfTiming.firstOutputTokenAt - perfTiming.upstreamCallStartedAt);
  if (outputTokens < 2) {
    scheduler(record(getRepo().performance.recordSample({ ...dims, ttftMs }), 'sample'));
    return;
  }
  // TPOT is the inter-token generation interval: streamDelta covers only the
  // (N-1) tokens that arrived AFTER firstOutputTokenAt, so the divisor is
  // outputTokens - 1. Matches the OpenTelemetry GenAI spec
  // gen_ai.server.time_per_output_token
  // (https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-metrics.md#metric-gen_aiservertime_per_output_token)
  // and Envoy AI Gateway
  // (https://aigateway.envoyproxy.io/docs/capabilities/observability/metrics/).
  const streamDeltaMs = requestFinishedAt - perfTiming.firstOutputTokenAt;
  const tpotUs = Math.round((streamDeltaMs * 1_000) / (outputTokens - 1));
  scheduler(record(getRepo().performance.recordSample({ ...dims, ttftMs, tpotUs }), 'sample'));
};

// Ctx-taking wrapper over recordRequestPerformance. Every data-plane
// caller already has a GatewayCtx in hand, so callers pass it directly
// instead of destructuring `.backgroundScheduler` and `.perfTiming` at
// each call site. `requestFinishedAt` is the caller's monotonic
// timestamp for the end of the token stream. It MUST be sampled before
// any post-stream persistence work (e.g. the usage D1 write in
// settleUsageAndPerformance) so TPOT reflects the stream itself rather
// than the persistence path.
export const recordPerformance = (
  ctx: GatewayCtx,
  telemetry: PerformanceTelemetryContext | undefined,
  failed: boolean,
  outputTokens: number,
  requestFinishedAt: number,
): void => {
  recordRequestPerformance(
    ctx.backgroundScheduler,
    ctx.perfTiming,
    telemetry,
    failed,
    outputTokens,
    requestFinishedAt,
  );
};

// Terminal-failure shortcut for every pre-stream / mid-stream error branch:
// the request produced no output tokens and settles as of now. Sole purpose
// is to keep the error-branch shape a single verb rather than a five-arg
// invocation repeated across every protocol renderer.
export const recordFailedRequest = (
  ctx: GatewayCtx,
  telemetry: PerformanceTelemetryContext | undefined,
): void => recordPerformance(ctx, telemetry, true, 0, performance.now());
