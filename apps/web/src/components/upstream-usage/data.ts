import { api, callApi } from '../../api/client';
import type { UpstreamOption } from '../../api/types';
import { nextCalendarDate, parseCalendarDate } from '../../lib/calendar-date';
import type { DashboardRange } from '../charts/dashboard-time';

const presetDays = { today: 1, '7d': 7, '30d': 30 } as const;
export type UpstreamUsageMetadata = Pick<UpstreamOption, 'id' | 'name' | 'kind' | 'hue'>;

export const upstreamUsageInterval = (range: DashboardRange, now: number) => typeof range === 'string'
  ? { start: now - presetDays[range] * 24 * 60 * 60 * 1000, end: now + 1 }
  : { start: parseCalendarDate(range.start).getTime(), end: parseCalendarDate(nextCalendarDate(range.end)).getTime() };

export const loadUpstreamUsage = async (range: DashboardRange, now: number, signal?: AbortSignal) => {
  const { start, end } = upstreamUsageInterval(range, now);
  const [usage, upstreams] = await Promise.all([
    callApi(() => api.api['upstream-usage'].$get({ query: { start, end } }, { init: { signal } })),
    callApi(() => api.api['upstream-options'].$get({}, { init: { signal } })),
  ]);
  if (usage.error) return { error: usage.error };
  if (upstreams.error) return { error: upstreams.error };
  return { data: { ...usage.data, upstreams: upstreams.data.map(({ id, name, kind, hue }) => ({ id, name, kind, hue } satisfies UpstreamUsageMetadata)) } };
};
