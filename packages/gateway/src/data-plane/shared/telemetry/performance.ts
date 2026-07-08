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

export interface UpstreamLatencyRecorder {
  record: <T>(promise: Promise<T>) => Promise<T>;
  durationMs: () => number | null;
}

// Gateway-side counterpart to `UpstreamCallOptions.recordUpstreamLatency`
// (see the contract docstring on that interface). Mints a fresh `record`
// for one provider call and reports back whether the wrap happened and
// what it measured. Kept separate from `UpstreamCallOptions` so future
// per-call hooks added to the options bag don't expand the recorder's
// surface.
//
// `durationMs()` returns `null` when the provider never wrapped a fetch.
// Consumers decide what the absence means:
//   - success-path consumers MUST treat null as a bug (a real upstream
//     call must instrument its round-trip),
//   - failure-path consumers may receive null because the provider
//     short-circuited at the gateway before any upstream call (e.g. a
//     request-side 400). When a failure path does have a duration, it is
//     free to record it.
//
// Per-call-site asserts (instead of a recorder-side throw) keep the
// "you forgot to wrap" error attached to the exact line that depends on
// the value.
export const createUpstreamLatencyRecorder = (): UpstreamLatencyRecorder => {
  let last: number | null = null;
  return {
    record: <T>(promise: Promise<T>): Promise<T> => {
      const startedAt = performance.now();
      return promise.finally(() => {
        last = performance.now() - startedAt;
      });
    },
    durationMs: () => last,
  };
};

// Asserts a recorded duration; throws if the wrap never happened. Use at
// any call site whose semantics require the value (every success-side
// record, plus the count_tokens contract guard).
export const requireRecordedDurationMs = (recorder: UpstreamLatencyRecorder, what: string): number => {
  const value = recorder.durationMs();
  if (value === null) throw new Error(`${what} returned without wrapping its fetch promise in opts.recordUpstreamLatency`);
  return value;
};
