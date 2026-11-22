import { currentHour } from './hour.ts';
import { performanceRecord } from './performance-record.ts';
import { getRepo } from '../../../repo/index.ts';
import type { GatewayCtx } from '../gateway-ctx.ts';
import type { PerformanceTelemetryContext } from '@floway-dev/provider';

export type { PerformanceTelemetryContext };

// Structural view of the fields recordPerformance actually reads. Every chat /
// passthrough call site passes its full `GatewayCtx`; the OpenAI Responses image-
// generation server tool synthesizes a per-dispatch object because each image
// call carries its own TTFT window and can't share `ctx.attempt` with the
// enclosing OpenAI Responses turn.
type PerformanceRecordScope = Pick<GatewayCtx, 'attempt' | 'backgroundScheduler'>;

const record = async (op: Promise<void>, label: string): Promise<void> => {
  try {
    await op;
  } catch (error) {
    console.warn(`Failed to record performance ${label}:`, error);
  }
};

// TTFT is anchored on the provider's outbound-fetch stamp, so the interval
// includes the gateway's own egress work — proxy-backoff lookup, dial, TLS,
// CONNECT — and excludes everything the gateway does before dispatch; after a
// failover the per-candidate anchor reset makes the recorded interval shorter
// than the latency the client observed. See
// `UpstreamCallOptions.wrapUpstreamCall`. Any success without a real upstream
// call or first-output-token stamp records as neutral; only genuine upstream
// failures with no output land in a pure zero-output-error bucket. TPOT layers
// on top only when at least two output tokens are reported — see the per-branch
// comments below.
//
// A failure after a decode signal with reported output tokens records a
// partial-output sample: the row bumps
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
  const { attempt, backgroundScheduler: scheduler } = ctx;
  const { performance } = getRepo();
  const measured = performanceRecord({
    dimensions: { ...telemetry, hour: currentHour() },
    firstOutputAt: attempt.timing.firstOutputTokenAt,
    upstreamStartedAt: attempt.timing.upstreamCallStartedAt,
    streamEndedAt: requestFinishedAt,
    outputTokens,
    failed,
  });
  switch (measured.kind) {
  case 'neutral': scheduler(record(performance.recordNeutral(measured.dimensions), measured.kind)); break;
  case 'zero-output-error': scheduler(record(performance.recordZeroOutputError(measured.dimensions), measured.kind)); break;
  case 'sample': scheduler(record(performance.recordSample(measured.sample), measured.kind)); break;
  }
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
