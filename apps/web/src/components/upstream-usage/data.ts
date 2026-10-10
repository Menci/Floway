import { api, callApi } from '../../api/client';
import { dashboardInterval, type DashboardRange } from '../charts/dashboard-time';

export const loadUpstreamUsage = (range: DashboardRange, now: number, signal?: AbortSignal) => {
  const { start, end } = dashboardInterval(range, now);
  return callApi(() => api.api['upstream-usage'].$get({ query: { start, end } }, { init: { signal } }));
};
