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

const recordNeutral = (dims: PerformanceDimensions): Promise<void> =>
  record(getRepo().performance.recordNeutral(dims), 'neutral');

const recordSample = (dims: PerformanceDimensions, ttftMs: number, tpotUs: number, outputTokens: number): Promise<void> =>
  record(getRepo().performance.recordSample({ ...dims, ttftMs, tpotUs, outputTokens }), 'sample');

// Non-chat operations record a neutral row on success (no TTFT/TPOT samples produced,
// requests counter only). A non-failed chat stream with no TTFT or no output tokens is
// still an error row — tpot requires both a first-token timestamp and a positive output-token count.
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
  if (failed) {
    scheduler(recordError(dims));
    return;
  }
  if (telemetry.operation !== 'chat') {
    scheduler(recordNeutral(dims));
    return;
  }
  if (ctx.perfTiming.firstOutputTokenAt === null || outputTokens <= 0) {
    scheduler(recordError(dims));
    return;
  }
  const ttftMs = Math.max(0, Math.round(ctx.perfTiming.firstOutputTokenAt - ctx.requestStartedAt));
  const streamUs = Math.max(0, Math.round((requestFinishedAt - ctx.perfTiming.firstOutputTokenAt) * 1_000));
  const tpotUs = Math.max(0, Math.round(streamUs / outputTokens));
  scheduler(recordSample(dims, ttftMs, tpotUs, outputTokens));
};
