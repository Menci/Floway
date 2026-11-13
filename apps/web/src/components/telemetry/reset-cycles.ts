import type { InferResponseType } from 'hono/client';

import { api, callApi, type ApiResult } from '../../api/client';
import { dashboardInterval, isResetRange, type DashboardRange, type DashboardResetRange } from '../charts/dashboard-time';
import { TELEMETRY_HOUR_MS, usageUpstreamFromDimensionValue } from '@floway-dev/protocols/browser';
import { upstreamMetricIdentityKey } from '@floway-dev/provider/browser';

export type UpstreamResetCycles = InferResponseType<(typeof api.api)['upstream-reset-cycles']['$get'], 200>;
export type ResetMetric = UpstreamResetCycles['metrics'][number];

export const singleTelemetryUpstream = (values: readonly string[], format: 'usage' | 'performance'): string | null => {
  if (values.length !== 1) return null;
  return format === 'usage' ? usageUpstreamFromDimensionValue(values[0]!) : values[0]!;
};

export const resetCycleRange = (cycles: UpstreamResetCycles, metric: ResetMetric, cycle: DashboardResetRange['cycle'], at: number): DashboardResetRange | null => {
  const start = cycle === 'current' ? metric.currentStart : metric.previousStart;
  const end = cycle === 'current' ? at : metric.currentStart;
  if (start === null || end === null || start >= end) return null;
  if (cycle === 'previous' && Math.floor(start / TELEMETRY_HOUR_MS) === Math.floor(end / TELEMETRY_HOUR_MS)) return null;
  return { kind: 'reset-cycle', cycle, upstreamId: cycles.upstreamId, metric: metric.identity, start, end };
};

export const loadTelemetryResetCycles = async (upstreamId: string | null, range: DashboardRange, at: number, signal?: AbortSignal): Promise<ApiResult<{ range: DashboardRange; resetCycles: UpstreamResetCycles | null }>> => {
  if (upstreamId === null) return { data: { range: isResetRange(range) ? 'today' : range, resetCycles: null } };
  const result = await callApi(() => api.api['upstream-reset-cycles'].$get({ query: { upstream_id: upstreamId, end: at } }, { init: { signal } }));
  if (result.error) return result;
  const resetCycles = result.data;
  if (!isResetRange(range)) return { data: { range, resetCycles } };
  const metric = range.upstreamId === upstreamId
    ? resetCycles.metrics.find(metric => upstreamMetricIdentityKey(metric.identity) === upstreamMetricIdentityKey(range.metric))
    : undefined;
  const next = metric === undefined ? null : resetCycleRange(resetCycles, metric, range.cycle, at);
  if (next !== null) dashboardInterval(next, at);
  return { data: { range: next ?? 'today', resetCycles } };
};
