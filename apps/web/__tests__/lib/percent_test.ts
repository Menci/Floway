import { describe, expect, it } from 'vitest';

import { NO_READING } from '../../src/lib/no-reading';
import { clampPercent, percentText } from '../../src/lib/percent';

describe('percentages', () => {
  it('keeps a reading inside the scale it is drawn on', () => {
    expect(clampPercent(-5)).toBe(0);
    expect(clampPercent(0)).toBe(0);
    expect(clampPercent(100)).toBe(100);
    expect(clampPercent(105)).toBe(100);
  });

  it('rounds to whole percent', () => {
    expect(clampPercent(49.4)).toBe(49);
    expect(clampPercent(49.5)).toBe(50);
  });

  // Unknown and zero are different readings, so an unusable one comes back as
  // null and is written as a dash rather than as 0%.
  it('reports an unusable reading as unknown rather than as zero', () => {
    expect(clampPercent(Number.NaN)).toBeNull();
    expect(clampPercent(Number.POSITIVE_INFINITY)).toBeNull();
    expect(percentText(null)).toBe(NO_READING);
    expect(percentText(0)).toBe('0%');
    expect(percentText(100)).toBe('100%');
  });
});
