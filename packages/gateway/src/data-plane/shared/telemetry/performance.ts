import { currentHour } from './hour.ts';
import { getRepo } from '../../../repo/index.ts';
import type { PerformanceDimensions } from '../../../repo/types.ts';
import type { GatewayCtx } from '../../chat/shared/gateway-ctx.ts';
import type { PerformanceTelemetryContext } from '@floway-dev/provider';

export type { PerformanceTelemetryContext };

// Structural view of the fields recordPerformance actually reads. Every chat /
// passthrough call site passes its full `GatewayCtx`; the Responses image-
// generation server tool synthesizes a per-dispatch object because each image
// call carries its own TTFT window and can't share `ctx.perfTiming` with the
// enclosing Responses turn.
type PerformanceRecordScope = Pick<GatewayCtx, 'perfTiming' | 'backgroundScheduler'>;

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

// TTFT is measured from the provider's outbound-fetch stamp so it isolates
// upstream round-trip latency from gateway-internal overhead. Any success
// without a real upstream call or first-output-token stamp records as
// neutral; only genuine upstream failures with no output land in a pure
// error bucket. TPOT layers on top only when at least two output tokens
// streamed — see the per-branch comments below.
//
// A failure that produced output tokens (mid-stream failure that streamed
// tokens before dying) records a partial-output sample: the row bumps
// `errors` AND `ttft_samples` (and `tpot_samples` when applicable) in a
// single atomic upsert, plus the `failed_with_output` counter so the
// aggregator can back the overlap out of `neutral`. The alternative —
// dropping the TTFT/TPOT reading — would hide upstream instability from
// the dashboard whenever failures cluster on real streams.
//
// `requestFinishedAt` is the caller's monotonic timestamp for the end of
// the token stream. It MUST be sampled before any post-stream persistence
// work (e.g. the usage D1 write in settleUsageAndPerformance) so TPOT
// reflects the stream itself rather than the persistence path.
export const recordPerformance = (
  ctx: PerformanceRecordScope,
  telemetry: PerformanceTelemetryContext | undefined,
  failed: boolean,
  outputTokens: number,
  requestFinishedAt: number,
): void => {
  if (!telemetry) return;
  if (outputTokens < 0) throw new Error(`recordPerformance: negative outputTokens=${outputTokens}`);
  const { perfTiming, backgroundScheduler: scheduler } = ctx;
  const dims = dimensions(telemetry);
  if (
    telemetry.operation !== 'chat' ||
    perfTiming.upstreamCallStartedAt === null ||
    perfTiming.firstOutputTokenAt === null ||
    (failed && outputTokens === 0)
  ) {
    // No TTFT stamp available (non-chat / no upstream call / no first-token
    // frame), or a failure that produced no tokens: settle to error or neutral
    // without a sample. TTFT + TPOT contribute only when a real inter-token
    // window exists AND the stream actually produced tokens.
    const settle = failed ? getRepo().performance.recordError(dims) : getRepo().performance.recordNeutral(dims);
    scheduler(record(settle, failed ? 'error' : 'neutral'));
    return;
  }
  const ttftMs = Math.round(perfTiming.firstOutputTokenAt - perfTiming.upstreamCallStartedAt);
  if (outputTokens < 2) {
    scheduler(record(getRepo().performance.recordSample({ ...dims, ttftMs, failed }), 'sample'));
    return;
  }
  // TPOT is the inter-token generation interval: streamDelta covers only the
  // (N-1) tokens that arrived AFTER firstOutputTokenAt, so the divisor is
  // outputTokens - 1. Matches the OpenTelemetry GenAI spec
  // gen_ai.server.time_per_output_token
  // (https://github.com/open-telemetry/semantic-conventions-genai/blob/953dd22e3cecd3a397d742c349d2435d59c8b771/docs/gen-ai/gen-ai-metrics.md#metric-gen_aiservertime_per_output_token)
  // and Envoy AI Gateway
  // (https://aigateway.envoyproxy.io/docs/capabilities/observability/metrics/).
  const streamDeltaMs = requestFinishedAt - perfTiming.firstOutputTokenAt;
  const tpotUs = Math.round((streamDeltaMs * 1_000) / (outputTokens - 1));
  scheduler(record(getRepo().performance.recordSample({ ...dims, ttftMs, tpotUs, failed }), 'sample'));
};

// Terminal-failure shortcut for every pre-stream / mid-stream error branch
// whose failure produced no output tokens (or whose caller doesn't have a
// token count in hand). Callers with a real usage figure should invoke
// `recordPerformance` directly so a partial-output failure can still
// contribute a TTFT / TPOT sample.
export const recordFailedRequest = (
  ctx: GatewayCtx,
  telemetry: PerformanceTelemetryContext | undefined,
): void => recordPerformance(ctx, telemetry, true, 0, performance.now());
