import { afterEach, expect, it, vi } from 'vitest';

import { dashboardInterval, type DashboardRange } from '../../../src/components/charts/dashboard-time';
import { loadUpstreamMetrics, upstreamMetricsInterval, upstreamMetricsStep } from '../../../src/components/upstream-metrics/data';
import { stubLocalStorage } from '../../local-storage-stub';

stubLocalStorage();
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it('uses the same aligned interval as the request Balance chart', () => {
  vi.stubEnv('TZ', 'Asia/Singapore');
  const now = Date.UTC(2026, 9, 11, 12, 34, 56, 789);
  for (const range of ['today', '7d', '30d', { start: '2026-10-10', end: '2026-10-11' }] satisfies DashboardRange[]) {
    expect(upstreamMetricsInterval(range, now)).toEqual(dashboardInterval(range, now));
  }
});

it('aligns custom calendar bounds to source-hour storage in a half-hour time zone', () => {
  vi.stubEnv('TZ', 'Asia/Kolkata');
  expect(upstreamMetricsInterval({ start: '2026-10-10', end: '2026-10-11' }, 0)).toEqual({ start: Date.UTC(2026, 9, 9, 19), end: Date.UTC(2026, 9, 11, 19) });
});

it('picks the finest step that keeps each series within the point budget', () => {
  const now = Date.UTC(2026, 9, 11, 12, 34, 56, 789);
  const minutes = (range: 'today' | '7d' | '30d') => {
    const { start, end } = upstreamMetricsInterval(range, now);
    return upstreamMetricsStep(start, end) / 60_000;
  };
  expect([minutes('today'), minutes('7d'), minutes('30d')]).toEqual([5, 30, 120]);
  expect(upstreamMetricsStep(0, 3 * 60 * 60_000)).toBe(60_000);
  expect(upstreamMetricsStep(0, 400 * 86_400_000)).toBe(2 * 86_400_000);
});

it('requests only the selected upstream and threads the cancellation signal', async () => {
  const history = { start: 0, end: 60_000, records: [{ upstreamId: 'seat', name: 'quota.remaining', labels: { quota: 'premium_interactions' }, value: 25, timestamp: 1_000 }] };
  const fetcher = vi.fn(async () => Response.json(history));
  vi.stubGlobal('fetch', fetcher);
  const controller = new AbortController();
  expect(await loadUpstreamMetrics('seat', 'today', 60_000, controller.signal)).toEqual({ data: history });
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [request, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(new URL(request, 'http://localhost').searchParams.get('upstream_id')).toBe('seat');
  expect(new URL(request, 'http://localhost').searchParams.get('step')).toBe('300000');
  expect(init.signal).toBe(controller.signal);
});

it('exposes metric-query failures without substituting an empty result', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'History unavailable' }, { status: 500 })));
  expect(await loadUpstreamMetrics('seat', 'today', 60_000)).toMatchObject({ error: { status: 500, message: 'History unavailable' } });
});
