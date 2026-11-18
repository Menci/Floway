import { describe, expect, it } from 'vitest';

import { formatCountdown } from '../../src/lib/format-duration';

describe('countdowns', () => {
  it('keeps counting seconds however long is left', () => {
    expect(formatCountdown(0, 'en')).toBe('0s');
    expect(formatCountdown(59, 'en')).toBe('59s');
    expect(formatCountdown(60, 'en')).toBe('1m 0s');
    expect(formatCountdown(3_599, 'en')).toBe('59m 59s');
    expect(formatCountdown(3_600, 'en')).toBe('60m 0s');
  });
});
