import { currentHour } from './hour.ts';
import { getRepo } from '../../../repo/index.ts';
import type { PerformanceDimensions } from '../../../repo/types.ts';
import type { GatewayCtx } from '../../chat/shared/gateway-ctx.ts';
import type { PerformanceTelemetryContext } from '@floway-dev/provider';

export type { PerformanceTelemetryContext };

// Structural view of the fields recordPerformance actually reads. Every chat /
// passthrough call site passes its full `GatewayCtx`; the Responses image-
// generation server tool synthesizes a per-dispatch object because each image
// call carries its own TTFT window and can't share `ctx.attempt` with the
// enclosing Responses turn.
type PerformanceRecordScope = Pick<GatewayCtx, 'attempt' | 'backgroundScheduler'>;

const record = async (op: Promise<void>, label: string): Promise<void> => {
  try {
    await op;
  } catch (error) {
    console.warn(`Failed to record performance ${label}:`, error);
  }
};

// TTFT is measured from the provider's outbound-fetch stamp so it isolates
// upstream round-trip latency from gateway-internal overhead. Any success
// without a real upstream call or first-output-token stamp records as
// neutral; only genuine upstream failures with no output land in a pure
// zero-output-error bucket. TPOT layers on top only when at least two
// output tokens streamed — see the per-branch comments below.
//
// A failure that produced output tokens (mid-stream failure that streamed
// tokens before dying) records a partial-output sample: the row bumps
// `errors_with_output` (and `tpot_samples` when applicable) in a single
// atomic upsert. The alternative — dropping the TTFT/TPOT reading — would
// hide upstream instability from the dashboard whenever failures cluster
// on real streams.
//
// `requestFinishedAt` is the caller's monotonic timestamp for the end of
// the token stream. Callers routing through `settle` inherit whatever
// timestamp they pass it (or the settle-time default) and no persistence
// work sits between the timestamp and the sample write.
export const recordPerformance = (
  ctx: PerformanceRecordScope,
  telemetry: PerformanceTelemetryContext | undefined,
  failed: boolean,
  outputTokens: number,
  requestFinishedAt: number,
): void => {
  if (!telemetry) return;
  if (outputTokens < 0) throw new Error(`recordPerformance: negative outputTokens=${outputTokens}`);
  const { attempt, backgroundScheduler: scheduler } = ctx;
  const dims: PerformanceDimensions = { ...telemetry, hour: currentHour() };
  if (
    telemetry.operation !== 'chat' ||
    attempt.upstreamCallStartedAt === null ||
    attempt.firstOutputTokenAt === null ||
    (failed && outputTokens === 0)
  ) {
    const settle = failed ? getRepo().performance.recordZeroOutputError(dims) : getRepo().performance.recordNeutral(dims);
    scheduler(record(settle, failed ? 'zero-output-error' : 'neutral'));
    return;
  }
  const ttftMs = Math.round(attempt.firstOutputTokenAt - attempt.upstreamCallStartedAt);
  const success = !failed;
  if (outputTokens < 2) {
    scheduler(record(getRepo().performance.recordSample({ ...dims, ttftMs, success }), 'sample'));
    return;
  }
  // TPOT is the inter-token generation interval: streamDelta covers only the
  // (N-1) tokens that arrived AFTER firstOutputTokenAt, so the divisor is
  // outputTokens - 1. Matches the OpenTelemetry GenAI spec
  // gen_ai.server.time_per_output_token
  // (https://github.com/open-telemetry/semantic-conventions-genai/blob/953dd22e3cecd3a397d742c349d2435d59c8b771/docs/gen-ai/gen-ai-metrics.md#metric-gen_aiservertime_per_output_token)
  // and Envoy AI Gateway
  // (https://aigateway.envoyproxy.io/docs/capabilities/observability/metrics/).
  const streamDeltaMs = requestFinishedAt - attempt.firstOutputTokenAt;
  const tpotUs = Math.round((streamDeltaMs * 1_000) / (outputTokens - 1));
  scheduler(record(getRepo().performance.recordSample({ ...dims, ttftMs, tpotUs, success }), 'sample'));
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
