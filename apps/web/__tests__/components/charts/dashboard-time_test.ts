import { afterEach, expect, test, vi } from 'vitest';

import { dashboardBucketFrames } from '../../../src/components/charts/dashboard-time';

afterEach(() => vi.unstubAllEnvs());

test('today keeps both repeated local hours as distinct frames', () => {
  vi.stubEnv('TZ', 'America/New_York');

  const frames = dashboardBucketFrames('today', Date.UTC(2026, 10, 1, 7, 30));
  const repeatedHour = frames.filter(({ date }) => (
    date.getFullYear() === 2026
    && date.getMonth() === 10
    && date.getDate() === 1
    && date.getHours() === 1
  ));

  expect(repeatedHour.map(frame => frame.key)).toEqual(['2026-11-01T05', '2026-11-01T06']);
  expect(new Set(frames.map(frame => frame.key)).size).toBe(24);
});
