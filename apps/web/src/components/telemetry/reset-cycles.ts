import type { InferResponseType } from 'hono/client';

import { api, callApi, type GlobalError } from '../../api/client';
import { isResetRange, type DashboardRange, type DashboardResetRange } from '../charts/dashboard-time';
import { usageUpstreamFromDimensionValue } from '@floway-dev/protocols/browser';
import { upstreamMetricIdentityKey, type UpstreamMetricIdentity } from '@floway-dev/upstream/browser';

export type ResetCycleHistory = InferResponseType<(typeof api.api)['upstream-reset-cycles']['$get'], 200>;
export type ResetMetric = ResetCycleHistory['metrics'][number];
export type ResetCycleQuota = NonNullable<NonNullable<ResetCycleHistory['cycle']>['quota']>;

export const singleTelemetryUpstream = (values: readonly string[], dimension: 'usage' | 'performance'): string | null => {
  const [value] = values;
  if (values.length !== 1 || value === undefined) return null;
  return dimension === 'usage' ? usageUpstreamFromDimensionValue(value) : value;
};

export const resetRangeAt = (upstreamId: string, metric: ResetMetric, offset: number): DashboardResetRange | null => {
  const start = metric.starts[offset];
  if (start === undefined) return null;
  return { kind: 'reset-cycle', upstreamId, metric: metric.identity, start, end: offset === 0 ? null : metric.starts[offset - 1]! };
};

export const readResetCycles = (
  upstreamId: string, before: number, signal: AbortSignal,
  options: { view: 'availability' } | { view: 'history'; metric?: UpstreamMetricIdentity; after?: number } | DashboardResetRange,
) => callApi(() => api.api['upstream-reset-cycles'].$get({
  query: 'view' in options
    ? {
        upstream_id: upstreamId, before, view: options.view,
        ...('metric' in options && options.metric !== undefined && { cycle_metric: upstreamMetricIdentityKey(options.metric) }),
        ...('after' in options && { after: options.after }),
      }
    : {
        upstream_id: upstreamId, before, cycle_metric: upstreamMetricIdentityKey(options.metric),
        cycle_start: options.start, ...(options.end === null && { current: '1' as const }),
      },
}, { init: { signal } }));

export const loadWithResetCycles = async <T>(
  upstreamId: string | null,
  requested: DashboardRange,
  at: number,
  signal: AbortSignal,
  load: (range: DashboardRange) => Promise<T>,
): Promise<{ data: T; range: DashboardRange; cycleQuota: ResetCycleQuota | null; error: GlobalError | null } | {
  data: null; range: DashboardResetRange; cycleQuota: null; error: GlobalError;
}> => {
  const range = isResetRange(requested) && requested.upstreamId !== upstreamId ? 'today' : requested;
  if (upstreamId === null || !isResetRange(range)) return { data: await load(range), range, cycleQuota: null, error: null };
  const result = await readResetCycles(upstreamId, at, signal, range);
  if (result.error) return { data: null, range, cycleQuota: null, error: result.error };
  const cycle = result.data.cycle;
  const resolved = cycle === undefined ? 'today'
    : cycle.start === range.start && cycle.end === range.end ? range
      : { ...range, start: cycle.start, end: cycle.end };
  return { data: await load(resolved), range: resolved, cycleQuota: cycle?.quota ?? null, error: null };
};
