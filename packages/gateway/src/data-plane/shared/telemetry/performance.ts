import { currentHour } from './hour.ts';
import { getRepo } from '../../../repo/index.ts';
import type { PerformanceDimensions, PerformanceSample, PerformanceErrorSample } from '../../../repo/types.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import type { PerformanceTelemetryContext } from '@floway-dev/provider';

export type { PerformanceTelemetryContext };

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

// A non-failed stream with no TTFT or no output tokens is still an error row —
// tpot cannot be computed without output.
export const recordRequestPerformance = (
  scheduler: BackgroundScheduler,
  ctx: { perfTiming: { firstOutputTokenAt: number | null }; requestStartedAt: number },
  telemetry: PerformanceTelemetryContext | undefined,
  failed: boolean,
  outputTokens: number,
  requestFinishedAt: number,
): void => {
  if (!telemetry) return;
  const dims: PerformanceDimensions = {
    hour: currentHour(),
    keyId: telemetry.keyId,
    model: telemetry.model,
    upstream: telemetry.upstream,
    runtimeLocation: telemetry.runtimeLocation,
  };
  if (failed || ctx.perfTiming.firstOutputTokenAt === null || outputTokens <= 0) {
    scheduler(recordError(dims));
    return;
  }
  const ttftMs = Math.max(0, Math.round(ctx.perfTiming.firstOutputTokenAt - ctx.requestStartedAt));
  const streamUs = Math.max(0, Math.round((requestFinishedAt - ctx.perfTiming.firstOutputTokenAt) * 1_000));
  const tpotUs = Math.max(0, Math.round(streamUs / outputTokens));
  scheduler(recordSample({ ...dims, ttftMs, tpotUs, outputTokens }));
};
