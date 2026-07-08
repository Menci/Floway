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

