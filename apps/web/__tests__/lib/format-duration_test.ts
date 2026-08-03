import { describe, expect, it } from 'vitest';

import { formatCountdown, formatDuration } from '../../src/lib/format-duration';
import { NO_READING } from '../../src/lib/no-reading';

describe('latency durations', () => {
  it('promotes a unit only once the reading reaches it', () => {
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(999)).toBe('999ms');
    expect(formatDuration(1_000)).toBe('1.0s');
    expect(formatDuration(1_500)).toBe('1.5s');
    expect(formatDuration(59_999)).toBe('60.0s');
    expect(formatDuration(60_000)).toBe('1.0m');
    expect(formatDuration(90_000)).toBe('1.5m');
  });

  it('reports no reading rather than a zero one', () => {
    expect(formatDuration(null)).toBe(NO_READING);
    expect(formatDuration(Number.NaN)).toBe(NO_READING);
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe(NO_READING);
  });
});

describe('countdowns', () => {
  it('keeps counting seconds however long is left', () => {
    expect(formatCountdown(0, 'en')).toBe('0s');
    expect(formatCountdown(59, 'en')).toBe('59s');
    expect(formatCountdown(60, 'en')).toBe('1m 0s');
    expect(formatCountdown(3_599, 'en')).toBe('59m 59s');
    expect(formatCountdown(3_600, 'en')).toBe('60m 0s');
  });

  it('floors a partial second and never counts below zero', () => {
    expect(formatCountdown(5.9, 'en')).toBe('5s');
    expect(formatCountdown(-3, 'en')).toBe('0s');
  });

  it('takes its unit names from the locale', () => {
    expect(formatCountdown(61, 'zh-Hans')).toBe('1分钟 1秒');
    expect(formatCountdown(30, 'zh-Hans')).toBe('30秒');
  });
});
