import { describe, expect, it } from 'vitest';

import {
  formatBytes,
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
