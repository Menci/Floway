import { afterEach, expect, it, vi } from 'vitest';

import { loadUpstreamUsage, upstreamUsageInterval } from '../../../src/components/upstream-usage/data';
import { stubLocalStorage } from '../../local-storage-stub';

stubLocalStorage();
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it('queries exact elapsed ranges without rounding minute-resolution history to hours', () => {
  const now = Date.UTC(2026, 9, 11, 12, 34, 56, 789);
  for (const [range, days] of [['today', 1], ['7d', 7], ['30d', 30]] as const) {
    expect(upstreamUsageInterval(range, now)).toEqual({ start: now - days * 86_400_000, end: now + 1 });
  }
});

it('includes complete custom calendar days in a time zone with a half-hour offset', () => {
  vi.stubEnv('TZ', 'Asia/Kolkata');
  expect(upstreamUsageInterval({ start: '2026-10-10', end: '2026-10-11' }, 0)).toEqual({ start: Date.UTC(2026, 9, 9, 18, 30), end: Date.UTC(2026, 9, 11, 18, 30) });
});

it('loads current upstream metadata separately from persisted metric observations', async () => {
  const history = { start: 0, end: 60_000, records: [{ upstreamId: 'seat', key: 'premium_interactions', value: 25, timestamp: 1_000 }] };
  const metadata = { id: 'seat', name: 'Renamed seat', hue: 300, kind: 'copilot', enabled: true, cachedModelCount: 1 };
  vi.stubGlobal('fetch', vi.fn(async (input: string) => Response.json(input.includes('upstream-options') ? [metadata] : history)));
  expect(await loadUpstreamUsage('today', 60_000)).toEqual({ data: { ...history, upstreams: [{ id: 'seat', name: 'Renamed seat', hue: 300, kind: 'copilot' }] } });
});

it('surfaces upstream metadata failures rather than displaying an empty chart', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: string) => input.includes('upstream-options')
    ? Response.json({ error: 'Upstream lookup failed' }, { status: 500 })
    : Response.json({ start: 0, end: 60_000, records: [] })));
  const result = await loadUpstreamUsage('today', 60_000);
  expect(result).toMatchObject({ error: { status: 500, message: 'Upstream lookup failed' } });
  expect(result.data).toBeUndefined();
});
