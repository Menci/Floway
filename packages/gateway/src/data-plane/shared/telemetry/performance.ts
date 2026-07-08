import { currentHour } from './hour.ts';
import { getRepo } from '../../../repo/index.ts';
import type { PerformanceDimensions, PerformanceSample, PerformanceErrorSample } from '../../../repo/types.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import type { PerformanceTelemetryContext } from '@floway-dev/provider';

export type { PerformanceTelemetryContext };

const dimensions = (telemetry: PerformanceTelemetryContext): PerformanceDimensions => ({
  hour: currentHour(),
  keyId: telemetry.keyId,
  model: telemetry.model,
  upstream: telemetry.upstream,
  runtimeLocation: telemetry.runtimeLocation,
});

const recordSample = async (sample: PerformanceSample): Promise<void> => {
  try {
    await getRepo().performance.recordSample(sample);
  } catch (error) {
    console.warn('Failed to record performance sample:', error);
  }
};

const recordError = async (dims: PerformanceErrorSample): Promise<void> => {
  try {
    await getRepo().performance.recordError(dims);
  } catch (error) {
    console.warn('Failed to record performance error:', error);
  }
};

// Records one perf write per request.
//   - telemetry === undefined → no attribution; skip.
//   - failed === true → error row.
//   - failed === false + valid TTFT + outputTokens > 0 → sample row with
//     ttft_ms and tpot_us computed from ctx.perfTiming and outputTokens.
//   - failed === false but missing TTFT or outputTokens <= 0 → error row
//     (a "successful" stream that produced no output is not a valid sample).
export const recordRequestPerformance = (
  scheduler: BackgroundScheduler,
  ctx: { perfTiming: { firstOutputTokenAt: number | null }; requestStartedAt: number },
  telemetry: PerformanceTelemetryContext | undefined,
  failed: boolean,
  outputTokens: number,
  requestFinishedAt: number,
): void => {
  if (!telemetry) return;
  const dims = dimensions(telemetry);
  if (failed || ctx.perfTiming.firstOutputTokenAt === null || outputTokens <= 0) {
    scheduler(recordError(dims));
    return;
  }
  const ttftMs = Math.max(0, Math.round(ctx.perfTiming.firstOutputTokenAt - ctx.requestStartedAt));
  const streamUs = Math.max(0, Math.round((requestFinishedAt - ctx.perfTiming.firstOutputTokenAt) * 1_000));
  const tpotUs = Math.max(0, Math.round(streamUs / outputTokens));
  scheduler(recordSample({ ...dims, ttftMs, tpotUs, outputTokens }));
};
