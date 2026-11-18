import { afterEach, expect, it, vi } from 'vitest';

import { loadUpstreamMetrics, upstreamMetricsInterval } from '../../../src/components/upstream-metrics/data';
import { stubLocalStorage } from '../../local-storage-stub';

stubLocalStorage();
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it('aligns custom calendar bounds to source-hour storage in a half-hour time zone', () => {
  vi.stubEnv('TZ', 'Asia/Kolkata');
  expect(upstreamMetricsInterval({ start: '2026-10-10', end: '2026-10-11' }, 0)).toEqual({ start: Date.UTC(2026, 9, 9, 19), end: Date.UTC(2026, 9, 11, 19) });
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
