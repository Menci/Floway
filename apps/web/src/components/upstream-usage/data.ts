import { api, callApi } from '../../api/client';
import { nextCalendarDate, parseCalendarDate } from '../../lib/calendar-date';
import type { DashboardRange } from '../charts/dashboard-time';

const presetDays = { today: 1, '7d': 7, '30d': 30 } as const;

export const upstreamUsageInterval = (range: DashboardRange, now: number) => typeof range === 'string'
  ? { start: now - presetDays[range] * 24 * 60 * 60 * 1000, end: now + 1 }
  : { start: parseCalendarDate(range.start).getTime(), end: parseCalendarDate(nextCalendarDate(range.end)).getTime() };

export const loadUpstreamUsage = (range: DashboardRange, now: number, signal?: AbortSignal) => {
  const { start, end } = upstreamUsageInterval(range, now);
  return callApi(() => api.api['upstream-usage'].$get({ query: { start, end } }, { init: { signal } }));
};
