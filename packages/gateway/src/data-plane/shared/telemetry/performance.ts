import { currentHour } from './hour.ts';
import { getRepo } from '../../../repo/index.ts';
import type { PerformanceDimensions } from '../../../repo/types.ts';
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

// TTFT is measured from perfTiming.upstreamCallStartedAt (the provider's
// outbound fetch), not from the request's arrival at the gateway — this
// isolates upstream round-trip latency from gateway-internal overhead.
// TTFT records whenever we have both stamps; TPOT layers on top only when
// output tokens >= 2 (a single token has no inter-token interval). Any
// success without a real upstream call or first-output-token stamp records
// as neutral; only genuine upstream failures land in the error bucket.
export const recordRequestPerformance = (
  scheduler: BackgroundScheduler,
  perfTiming: { upstreamCallStartedAt: number | null; firstOutputTokenAt: number | null },
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
  const ttftDeltaMs = perfTiming.firstOutputTokenAt - perfTiming.upstreamCallStartedAt;
  if (ttftDeltaMs < 0) {
    // Stale upstreamCallStartedAt outran firstOutputTokenAt (should not happen
    // now that iterateCandidates resets per attempt, but the negative-latency
    // sample would be nonsense either way).
    scheduler(record(getRepo().performance.recordNeutral(dims), 'neutral'));
    return;
  }
  const ttftMs = Math.round(ttftDeltaMs);
  if (outputTokens < 2) {
    scheduler(record(getRepo().performance.recordSample({ ...dims, ttftMs }), 'sample'));
    return;
  }
  const streamDeltaMs = requestFinishedAt - perfTiming.firstOutputTokenAt;
  if (streamDeltaMs < 0) {
    scheduler(record(getRepo().performance.recordSample({ ...dims, ttftMs }), 'sample'));
    return;
  }
  const tpotUs = Math.round((streamDeltaMs * 1_000) / outputTokens);
  scheduler(record(getRepo().performance.recordSample({ ...dims, ttftMs, tpotUs, outputTokens }), 'sample'));
};
