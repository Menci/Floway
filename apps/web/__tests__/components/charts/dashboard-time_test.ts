import { afterEach, expect, test, vi } from 'vitest';

import { dashboardBucketFrames, dashboardBucketMapper, dashboardGranularity, dashboardInterval, dashboardRangeFromInterval, formatBucketInterval, parseDashboardRange, serializeDashboardRange } from '../../../src/components/charts/dashboard-time';

afterEach(() => vi.unstubAllEnvs());

test.each(['en-US', 'zh-Hans'])('bucket tooltip omits years across year boundaries in %s', locale => {
  vi.stubEnv('TZ', 'Asia/Singapore');
  const range = { start: Date.UTC(2026, 11, 31), end: Date.UTC(2027, 0, 1) };
  const frame = { ...dashboardBucketFrames(range, 0)[0]!, ...range };
  const title = formatBucketInterval(frame, locale);
  expect(title).not.toMatch(/2026|2027|年/);
  expect(title).toContain('31');
  expect(title).toContain('08:00');
});

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

test('presets preserve their window and bucket counts', () => {
  vi.stubEnv('TZ', 'Asia/Singapore');
  const now = Date.UTC(2026, 9, 10, 6, 37);
  expect(dashboardBucketFrames('today', now)).toHaveLength(24);
  expect(dashboardBucketFrames('7d', now)).toHaveLength(42);
  expect(dashboardBucketFrames('30d', now)).toHaveLength(30);
  expect(dashboardInterval('30d', now).start).toBe(Date.UTC(2026, 8, 10, 16));
});

test('custom aggregation adapts to interval density', () => {
  const start = Date.UTC(2026, 0, 1);
  const range = (days: number) => ({ start, end: start + days * 24 * 3_600_000 });
  expect(dashboardGranularity(range(1), 0)).toBe('hour');
  expect(dashboardGranularity(range(7), 0)).toBe('4h');
  expect(dashboardGranularity(range(14), 0)).toBe('8h');
  expect(dashboardGranularity(range(30), 0)).toBe('day');
  expect(dashboardGranularity(range(180), 0)).toBe('week');
  expect(dashboardGranularity(range(365), 0)).toBe('month');
  for (const days of [1, 7, 14, 30, 180, 365]) expect(dashboardBucketFrames(range(days), 0).length).toBeLessThanOrEqual(48);
});

test('first and last natural buckets clip to the exact query interval', () => {
  const range = { start: Date.UTC(2026, 9, 1, 14), end: Date.UTC(2026, 10, 1, 16) };
  const frames = dashboardBucketFrames(range, 0);
  expect(frames[0]?.start).toBe(range.start);
  expect(frames.at(-1)?.end).toBe(range.end);
  expect(frames.every(frame => frame.start >= range.start && frame.end <= range.end)).toBe(true);
  expect(frames.reduce((sum, frame) => sum + frame.end - frame.start, 0)).toBe(range.end - range.start);
});

test('only matching current endpoints enable preset following', () => {
  const now = Date.UTC(2026, 9, 10, 14, 30);
  const interval = dashboardInterval('today', now);
  expect(dashboardRangeFromInterval(interval.start, interval.end, now)).toBe('today');
  const yesterday = { start: interval.start - 24 * 3_600_000, end: interval.end - 24 * 3_600_000 };
  expect(dashboardRangeFromInterval(yesterday.start, yesterday.end, now)).toEqual(yesterday);
});

test('absolute intervals survive a URL roundtrip without becoming relative', () => {
  const range = { start: Date.UTC(2026, 4, 5, 20), end: Date.UTC(2026, 4, 7, 21) };
  const params = new URLSearchParams();
  serializeDashboardRange(params, range);
  expect(parseDashboardRange(params)).toEqual(range);
  expect(() => parseDashboardRange(new URLSearchParams('r=custom&start=invalid&end=2026-05-07T21'))).toThrow();
});

test('fractional-offset zones render exactly the queried UTC hours', () => {
  vi.stubEnv('TZ', 'Asia/Kolkata');
  const now = Date.UTC(2026, 9, 10, 14, 30);
  const interval = dashboardInterval('today', now);
  const frames = dashboardBucketFrames('today', now);
  expect(frames).toHaveLength(24);
  expect(frames[0]?.start).toBe(interval.start);
  expect(frames.at(-1)?.end).toBe(interval.end);
});

test('custom bucket keys match the server through DST and fractional offsets', () => {
  for (const zone of ['America/New_York', 'Asia/Kathmandu']) {
    vi.stubEnv('TZ', zone);
    const range = { start: Date.UTC(2026, 9, 25, 14), end: Date.UTC(2026, 10, 10, 16) };
    const frames = dashboardBucketFrames(range, 0);
    const mapper = dashboardBucketMapper(range, 0);
    for (const frame of frames) expect(mapper(new Date(frame.start).toISOString().slice(0, 13))).toBe(frame.key);
    expect(frames.reduce((sum, frame) => sum + frame.end - frame.start, 0)).toBe(range.end - range.start);
  }
});
