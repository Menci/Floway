import { describe, expect, it } from 'vitest';

import {
  formatBytes,
  formatCompactCount,
  formatTokenRate,
} from '../../src/lib/format-number';
import { NO_READING } from '../../src/lib/no-reading';

describe('byte sizes', () => {
  it('drops the fraction digit once a unit reaches double digits', () => {
    expect(formatBytes(9.5 * 1024, 'en')).toBe('9.5 KB');
    expect(formatBytes(10.5 * 1024, 'en')).toBe('11 KB');
    expect(formatBytes(9.5 * 1024 ** 2, 'en')).toBe('9.5 MB');
    expect(formatBytes(10.5 * 1024 ** 2, 'en')).toBe('11 MB');
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
});
