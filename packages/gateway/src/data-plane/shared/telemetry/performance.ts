import { currentHour } from './hour.ts';
import { getRepo } from '../../../repo/index.ts';
import type { PerformanceDimensions, PerformanceMetricScope } from '../../../repo/types.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import type { PerformanceTelemetryContext } from '@floway-dev/provider';

export type { PerformanceTelemetryContext };

const performanceDimensions = (context: PerformanceTelemetryContext, metricScope: PerformanceMetricScope): PerformanceDimensions => ({
  hour: currentHour(),
  metricScope,
  keyId: context.keyId,
  model: context.model,
  upstream: context.upstream,
  modelKey: context.modelKey,
  stream: context.stream,
  runtimeLocation: context.runtimeLocation,
});

export async function recordPerformanceLatency(context: PerformanceTelemetryContext, metricScope: PerformanceMetricScope, durationMs: number): Promise<void> {
  try {
    await getRepo().performance.recordLatency({
      ...performanceDimensions(context, metricScope),
      durationMs,
    });
  } catch (error) {
    console.warn('Failed to record performance latency:', error);
  }
}

export async function recordPerformanceError(context: PerformanceTelemetryContext, metricScope: PerformanceMetricScope): Promise<void> {
  try {
    await getRepo().performance.recordError(performanceDimensions(context, metricScope));
  } catch (error) {
    console.warn('Failed to record performance error:', error);
  }
}

export const recordRequestPerformance = (
  scheduler: BackgroundScheduler,
  context: PerformanceTelemetryContext | undefined,
  failed: boolean,
  durationMs: number,
): void => {
  if (!context) return;
  scheduler(failed ? recordPerformanceError(context, 'request_total') : recordPerformanceLatency(context, 'request_total', durationMs));
};

// Gateway-side counterpart to `UpstreamCallOptions.recordUpstreamLatency` (see
// the contract docstring on that interface). Mints a fresh `record` for one
// provider call and reads back the wrapped promise's duration after the call
// returns; `durationMs()` throws when the provider returned without ever
// wrapping. Kept separate from `UpstreamCallOptions` so future per-call hooks
// added to the options bag don't expand the recorder's surface.
export const createUpstreamLatencyRecorder = () => {
  let last: number | undefined;
  return {
    record: <T>(promise: Promise<T>): Promise<T> => {
      const startedAt = performance.now();
      return promise.finally(() => {
        last = performance.now() - startedAt;
      });
    },
    durationMs: (): number => {
      if (last === undefined) {
        throw new Error('upstream call returned without wrapping its fetch promise in opts.recordUpstreamLatency');
      }
      return last;
    },
  };
};
