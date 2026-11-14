import { describe, expect, it } from 'vitest';

import { formatCountdown, formatDuration, formatRemaining } from '../../src/lib/format-duration';
import { NO_READING } from '../../src/lib/no-reading';

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

  it('reports no reading rather than a zero one', () => {
    expect(formatDuration(null, 'en')).toBe(NO_READING);
    expect(formatDuration(Number.NaN, 'zh-Hans')).toBe(NO_READING);
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
    expect(formatCountdown(61, 'zh-Hans')).toBe('1 分钟 1 秒');
    expect(formatCountdown(30, 'zh-Hans')).toBe('30 秒');
  });
});

describe('remaining waits', () => {
  it('keeps the Latin suffixes in English', () => {
    expect(formatRemaining(0, 'en')).toBe('0m');
    expect(formatRemaining(60_000, 'en')).toBe('1m');
    expect(formatRemaining(90 * 60_000, 'en')).toBe('1h 30m');
    expect(formatRemaining(48 * 3_600_000, 'en')).toBe('48h');
  });

  it('uses Chinese unit words for the same wait', () => {
    expect(formatRemaining(90 * 60_000, 'zh-Hans')).toBe('1 小时 30 分钟');
    expect(formatRemaining(48 * 3_600_000, 'zh-Hans')).toBe('48 小时');
  });
});
