import { describe, expect, it } from 'vitest';

import {
  formatBytes,
  formatCompactCount,
  formatCount,
  formatTokenRate,
  formatTokenRateFromTpot,
} from '../../src/lib/format-number';
import { NO_READING } from '../../src/lib/no-reading';

describe('byte sizes', () => {
  it('stays in bytes up to the first kilobyte', () => {
    expect(formatBytes(0, 'en')).toBe('0 B');
    expect(formatBytes(1023, 'en')).toBe('1023 B');
    expect(formatBytes(1024, 'en')).toBe('1 KB');
  });

  it('drops the fraction digit once a unit reaches double digits', () => {
    expect(formatBytes(9.5 * 1024, 'en')).toBe('9.5 KB');
    expect(formatBytes(10.5 * 1024, 'en')).toBe('11 KB');
    expect(formatBytes(9.5 * 1024 ** 2, 'en')).toBe('9.5 MB');
    expect(formatBytes(10.5 * 1024 ** 2, 'en')).toBe('11 MB');
  });

  it('changes unit only at the binary boundary', () => {
    expect(formatBytes(1024 ** 2 - 1, 'en')).toBe('1,024 KB');
    expect(formatBytes(1024 ** 2, 'en')).toBe('1 MB');
    expect(formatBytes(1024 ** 3 - 1, 'en')).toBe('1,024 MB');
    expect(formatBytes(1024 ** 3, 'en')).toBe('1 GB');
  });

  // The top of the ladder has no unit above it to promote to, so it keeps two
  // fraction digits instead of one.
  it('keeps three significant figures at the top of the ladder', () => {
    expect(formatBytes(1.25 * 1024 ** 3, 'en')).toBe('1.25 GB');
    expect(formatBytes(64 * 1024 ** 3, 'en')).toBe('64 GB');
  });
});

describe('counts', () => {
  it('abbreviates the way the locale does, not the way English does', () => {
    expect(formatCompactCount(12_345, 'en')).toBe('12.3K');
    expect(formatCompactCount(12_345, 'zh-Hans')).toBe('1.2万');
    expect(formatCompactCount(999, 'en')).toBe('999');
  });

  it('rounds to a whole tally and never reports a negative one', () => {
    expect(formatCount(12_345.6, 'en')).toBe('12,346');
    expect(formatCount(0, 'en')).toBe('0');
    expect(formatCount(-5, 'en')).toBe('0');
  });
});

describe('token rates', () => {
  it('narrows the fraction as the rate grows', () => {
    expect(formatTokenRate(9.99)).toBe('9.99 tok/s');
    expect(formatTokenRate(10)).toBe('10.0 tok/s');
    expect(formatTokenRate(99.99)).toBe('100.0 tok/s');
    expect(formatTokenRate(100)).toBe('100 tok/s');
    expect(formatTokenRate(123.4)).toBe('123 tok/s');
  });

  it('reports no rate rather than a zero one', () => {
    expect(formatTokenRate(null)).toBe(NO_READING);
    expect(formatTokenRate(0)).toBe(NO_READING);
    expect(formatTokenRate(-1)).toBe(NO_READING);
    expect(formatTokenRate(Number.NaN)).toBe(NO_READING);
    expect(formatTokenRate(Number.POSITIVE_INFINITY)).toBe(NO_READING);
  });

  it('inverts a time per output token into a rate', () => {
    expect(formatTokenRateFromTpot(10_000)).toBe('100 tok/s');
    expect(formatTokenRateFromTpot(50_000)).toBe('20.0 tok/s');
    expect(formatTokenRateFromTpot(null)).toBe(NO_READING);
    expect(formatTokenRateFromTpot(0)).toBe(NO_READING);
    expect(formatTokenRateFromTpot(-10)).toBe(NO_READING);
  });
});
