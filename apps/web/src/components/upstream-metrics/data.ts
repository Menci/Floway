import { api, callApi } from '../../api/client';
import type { UpstreamOption } from '../../api/types';
import { dashboardInterval, type DashboardRange } from '../charts/dashboard-time';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
// The smallest listed step that keeps each series within the point budget:
// a day reads at 5 minutes, a week at 30 minutes and a month at 2 hours.
const STEP_MINUTES = [1, 5, 15, 30, 60, 120, 360, 720, 1_440] as const;
const POINT_BUDGET = 360;
export type UpstreamMetricsMetadata = Pick<UpstreamOption, 'id' | 'name' | 'kind' | 'hue'>;

export const upstreamMetricsInterval = dashboardInterval;

export const upstreamMetricsStep = (start: number, end: number): number => {
  const span = end - start;
  const minutes = STEP_MINUTES.find(candidate => Math.floor(span / (candidate * MINUTE_MS)) <= POINT_BUDGET);
  return minutes === undefined ? Math.ceil(span / POINT_BUDGET / DAY_MS) * DAY_MS : minutes * MINUTE_MS;
};

export const loadUpstreamMetrics = async (upstreamId: string, range: DashboardRange, now: number, signal?: AbortSignal) => {
  const { start, end } = upstreamMetricsInterval(range, now);
  const step = upstreamMetricsStep(start, end);
  return await callApi(() => api.api['upstream-metrics'].$get({ query: { upstream_id: upstreamId, start, end, step } }, { init: { signal } }));
};
