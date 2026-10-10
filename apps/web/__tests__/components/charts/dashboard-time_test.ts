import { afterEach, expect, test, vi } from 'vitest';

import { chartTickValues, dashboardBucketFrames, dashboardBucketMapper, dashboardGranularity, dashboardInterval, dashboardRangeIsCurrent, formatBucketInterval, parseDashboardRange, serializeDashboardRange } from '../../../src/components/charts/dashboard-time';
import { calendarDate } from '../../../src/lib/calendar-date';

afterEach(() => vi.unstubAllEnvs());

test.each(['en-US', 'zh-Hans'])('bucket tooltip omits years across year boundaries in %s', locale => {
  vi.stubEnv('TZ', 'Asia/Singapore');
  const range = { start: '2026-12-31', end: '2027-01-01' };
  const interval = dashboardInterval(range, 0);
  const frame = { ...dashboardBucketFrames(range, 0)[0]!, ...interval };
  expect(formatBucketInterval(frame, locale)).not.toMatch(/2026|2027|年/);
});

test('presets retain their original windows and aggregation densities', () => {
  vi.stubEnv('TZ', 'Asia/Singapore');
  const now = Date.UTC(2026, 9, 10, 6, 37);
  expect(dashboardBucketFrames('today', now)).toHaveLength(24);
  expect(dashboardBucketFrames('7d', now)).toHaveLength(42);
  expect(dashboardBucketFrames('30d', now)).toHaveLength(30);
  expect(dashboardInterval('30d', now).start).toBe(Date.UTC(2026, 8, 10, 16));
});

test('custom aggregation adapts to inclusive calendar-day density', () => {
  vi.stubEnv('TZ', 'UTC');
  const range = (days: number) => ({ start: '2026-01-01', end: calendarDate(new Date(2026, 0, days)) });
  expect(dashboardGranularity(range(1), 0)).toBe('hour');
  expect(dashboardGranularity(range(7), 0)).toBe('4h');
  expect(dashboardGranularity(range(14), 0)).toBe('8h');
  expect(dashboardGranularity(range(30), 0)).toBe('day');
  expect(dashboardGranularity(range(180), 0)).toBe('week');
  expect(dashboardGranularity(range(365), 0)).toBe('month');
  for (const days of [1, 7, 14, 30, 180, 365]) expect(dashboardBucketFrames(range(days), 0).length).toBeLessThanOrEqual(48);
});

test('custom includes the complete last day and remains fixed as time advances', () => {
  vi.stubEnv('TZ', 'Asia/Singapore');
  const range = { start: '2026-10-01', end: '2026-10-03' };
  const interval = { start: Date.UTC(2026, 8, 30, 16), end: Date.UTC(2026, 9, 3, 16) };
  expect(dashboardInterval(range, 0)).toEqual(interval);
  expect(dashboardInterval(range, Date.UTC(2027, 0, 1))).toEqual(interval);
  const frames = dashboardBucketFrames(range, 0);
  expect(frames[0]?.start).toBe(interval.start);
  expect(frames.at(-1)?.end).toBe(interval.end);
  expect(frames.reduce((sum, frame) => sum + frame.end - frame.start, 0)).toBe(interval.end - interval.start);
});

test('date URLs preserve Custom independently from preset matching', () => {
  const range = { start: '2026-10-10', end: '2026-10-10' };
  const params = new URLSearchParams();
  serializeDashboardRange(params, range);
  expect(params.toString()).toBe('r=custom&start=2026-10-10&end=2026-10-10');
  expect(parseDashboardRange(params)).toEqual(range);
  for (const value of ['2026-02-30', 'invalid', '2026-10-10T00']) expect(() => parseDashboardRange(new URLSearchParams(`r=custom&start=${value}&end=2026-10-10`))).toThrow();
  expect(() => parseDashboardRange(new URLSearchParams('r=custom&start=2026-10-11&end=2026-10-10'))).toThrow();
});

test('only custom ranges covering the current local date poll', () => {
  vi.stubEnv('TZ', 'Asia/Singapore');
  const now = Date.UTC(2026, 9, 9, 17);
  expect(dashboardRangeIsCurrent('today', now)).toBe(true);
  expect(dashboardRangeIsCurrent({ start: '2026-10-09', end: '2026-10-09' }, now)).toBe(false);
  expect(dashboardRangeIsCurrent({ start: '2026-10-10', end: '2026-10-10' }, now)).toBe(true);
  expect(dashboardRangeIsCurrent({ start: '2026-10-11', end: '2026-10-12' }, now)).toBe(false);
});

test('whole local days retain DST and fractional-offset UTC hour coverage', () => {
  for (const zone of ['America/New_York', 'Asia/Kathmandu']) {
    vi.stubEnv('TZ', zone);
    const range = { start: '2026-10-25', end: '2026-11-10' };
    const interval = dashboardInterval(range, 0);
    const frames = dashboardBucketFrames(range, 0);
    const mapper = dashboardBucketMapper(range, 0);
    for (const frame of frames) expect(mapper(new Date(frame.start).toISOString().slice(0, 13))).toBe(frame.key);
    expect(frames.reduce((sum, frame) => sum + frame.end - frame.start, 0)).toBe(interval.end - interval.start);
  }
  vi.stubEnv('TZ', 'America/New_York');
  expect(dashboardBucketFrames({ start: '2026-11-01', end: '2026-11-01' }, 0)).toHaveLength(25);
  expect(dashboardBucketFrames({ start: '2026-03-08', end: '2026-03-08' }, 0)).toHaveLength(23);
});

test('chart ticks distribute both endpoints without crowding the final two labels', () => {
  const buckets = Array.from({ length: 32 }, (_, index) => ({ date: new Date(2026, 9, 10 + index), index }));
  expect(chartTickValues(buckets).map(bucket => bucket.index)).toEqual([0, 5, 10, 16, 21, 26, 31]);
  expect(chartTickValues(buckets.slice(0, 7))).toEqual(buckets.slice(0, 7));
});
