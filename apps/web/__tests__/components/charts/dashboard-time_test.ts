import { afterEach, expect, test, vi } from 'vitest';

import { dashboardBucketFrames, dashboardBucketMapper, dashboardGranularity, dashboardInterval, dashboardRangeIsCurrent, parseDashboardRange, serializeDashboardRange } from '../../../src/components/charts/dashboard-time';
import { calendarDate } from '../../../src/lib/calendar-date';

afterEach(() => vi.unstubAllEnvs());

test('custom aggregation adapts to inclusive calendar-day density', () => {
  vi.stubEnv('TZ', 'UTC');
  const range = (days: number) => ({ start: '2026-01-01', end: calendarDate(new Date(2026, 0, days)) });
  expect(dashboardGranularity(range(1), 0)).toBe('hour');
  expect(dashboardGranularity(range(3), 0)).toBe('2h');
  expect(dashboardGranularity(range(7), 0)).toBe('4h');
  expect(dashboardGranularity(range(9), 0)).toBe('6h');
  expect(dashboardGranularity(range(14), 0)).toBe('8h');
  expect(dashboardGranularity(range(17), 0)).toBe('12h');
  expect(dashboardGranularity(range(30), 0)).toBe('day');
  expect(dashboardGranularity(range(49), 0)).toBe('2d');
  expect(dashboardGranularity(range(96), 0)).toBe('2d');
  expect(dashboardGranularity(range(97), 0)).toBe('3d');
  expect(dashboardGranularity(range(180), 0)).toBe('4d');
  expect(dashboardGranularity(range(365), 0)).toBe('8d');
  for (const days of [1, 2, 3, 4, 5, 8, 9, 12, 13, 16, 17, 24, 25, 48, 49, 96, 97, 180, 365, 20_000]) expect(dashboardBucketFrames(range(days), 0).length).toBeLessThanOrEqual(48);
});

test('multi-day buckets start at the selected date and clip the last bucket', () => {
  vi.stubEnv('TZ', 'Asia/Singapore');
  for (const start of ['2026-01-04', '2026-01-05']) {
    const last = new Date(`${start}T00:00:00`);
    last.setDate(last.getDate() + 332);
    const range = { start, end: calendarDate(last) };
    const frames = dashboardBucketFrames(range, 0);
    expect(dashboardGranularity(range, 0)).toBe('7d');
    expect(frames).toHaveLength(48);
    expect(frames[0]?.key).toBe(start);
    expect(frames.at(-1)?.end).toBe(dashboardInterval(range, 0).end);
    expect(frames.at(-1)!.end - frames.at(-1)!.start).toBe(4 * 24 * 3_600_000);
  }
});

test.each([
  ['America/New_York', '2026-03-07', '2026-03-09'],
  ['America/New_York', '2026-10-31', '2026-11-02'],
  ['Australia/Lord_Howe', '2026-10-03', '2026-10-05'],
  ['America/Santiago', '2026-09-04', '2026-10-23'],
  ['Pacific/Apia', '2011-12-02', '2012-01-20'],
  ['Asia/Kathmandu', '2026-01-01', '2026-03-01'],
])('every source hour stays in its frontend bucket across %s calendar transitions', (zone, start, end) => {
  vi.stubEnv('TZ', zone);
  const range = { start, end };
  const interval = dashboardInterval(range, 0);
  const frames = dashboardBucketFrames(range, 0);
  const mapper = dashboardBucketMapper(range, 0);
  expect(frames.length).toBeLessThanOrEqual(48);
  expect(frames[0]?.start).toBe(interval.start);
  expect(frames.at(-1)?.end).toBe(interval.end);
  expect(frames.reduce((sum, frame) => sum + frame.end - frame.start, 0)).toBe(interval.end - interval.start);
  for (const [index, frame] of frames.entries()) {
    if (index > 0) expect(frame.start).toBe(frames[index - 1]!.end);
    for (let hour = frame.start; hour < frame.end; hour += 3_600_000) expect(mapper(new Date(hour).toISOString().slice(0, 13))).toBe(frame.key);
  }
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
