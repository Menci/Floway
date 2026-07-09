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

// Three outcome classes:
//
//   error   — upstream genuinely failed (`failed === true`).
//   neutral — no TTFT/TPOT semantics: non-chat operation, no upstream call
//             (synthetic result), no generated token, or too few tokens to
//             compute a per-token rate (outputTokens < 2). Successful but
//             degenerate cases (client disconnect, reasoning-only, single-token
//             stream) land here rather than in error.
//   sample  — chat operation with a real upstream call, a first-generated-token
//             stamp, and ≥ 2 output tokens. TTFT is measured from
//             upstreamCallStartedAt (the provider's outbound fetch) to the first
//             generated token, isolating upstream round-trip latency from
//             gateway-internal overhead.
export const recordRequestPerformance = (
  scheduler: BackgroundScheduler,
  ctx: { perfTiming: { firstGeneratedTokenAt: number | null; upstreamCallStartedAt: number | null } },
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
  // Non-chat operations always neutral (no TTFT/TPOT semantic).
  if (telemetry.operation !== 'chat') {
    scheduler(record(getRepo().performance.recordNeutral(dims), 'neutral'));
    return;
  }
  // Chat but no upstream call (synthetic result) OR no generated token OR too
  // few tokens to compute a per-token rate → also neutral. Only real upstream
  // failures land in `error`.
  if (
    ctx.perfTiming.upstreamCallStartedAt === null ||
    ctx.perfTiming.firstGeneratedTokenAt === null ||
    outputTokens < 2
  ) {
    scheduler(record(getRepo().performance.recordNeutral(dims), 'neutral'));
    return;
  }
  const ttftMs = Math.round(ctx.perfTiming.firstGeneratedTokenAt - ctx.perfTiming.upstreamCallStartedAt);
  const streamUs = Math.round((requestFinishedAt - ctx.perfTiming.firstGeneratedTokenAt) * 1_000);
  const tpotUs = Math.round(streamUs / outputTokens);
  scheduler(record(getRepo().performance.recordSample({ ...dims, ttftMs, tpotUs, outputTokens }), 'sample'));
};
