import { describe, expect, it } from 'vitest';

import { formatCountdown, formatDuration, formatRemaining } from '../../src/lib/format-duration';

describe('durations', () => {
  it('keeps the SI ladder in English', () => {
    expect(formatDuration(0, 'en')).toBe('0ms');
    expect(formatDuration(999, 'en')).toBe('999ms');
    expect(formatDuration(1_500, 'en')).toBe('1.5s');
    expect(formatDuration(90_000, 'en')).toBe('1.5m');
  });

  it('spells a Chinese unit word after a space', () => {
    expect(formatDuration(0, 'zh-Hans')).toBe('0 毫秒');
    expect(formatDuration(999, 'zh-Hans')).toBe('999 毫秒');
    expect(formatDuration(1_500, 'zh-Hans')).toBe('1.5 秒');
    expect(formatDuration(90_000, 'zh-Hans')).toBe('1.5 分钟');
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
});

describe('remaining waits', () => {
  it('keeps the Latin suffixes in English', () => {
    expect(formatRemaining(0, 'en')).toBe('0m');
    expect(formatRemaining(60_000, 'en')).toBe('1m');
    expect(formatRemaining(90 * 60_000, 'en')).toBe('1h 30m');
    expect(formatRemaining(48 * 3_600_000, 'en')).toBe('48h');
  });
});
