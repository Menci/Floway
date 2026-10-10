import { afterEach, expect, it, vi } from 'vitest';

import { upstreamUsageInterval } from '../../../src/components/upstream-usage/data';

afterEach(() => vi.unstubAllEnvs());

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
