import { describe, expect, it } from 'vitest';

import { colorForHue, hueForSeriesSlot } from '../../../src/components/charts/palette';

describe('chart series colors', () => {
  it('renders every hue at one OKLCH lightness and chroma', () => {
    expect(colorForHue(0)).toBe('oklch(0.7 0.13 0)');
    expect(colorForHue(217)).toBe('oklch(0.7 0.13 217)');
  });

  it('keeps the original palette identities as a repeating hue sequence', () => {
    expect(Array.from({ length: 10 }, (_, slot) => hueForSeriesSlot(slot)))
      .toEqual([251, 144, 10, 46, 302, 198, 54, 250, 128, 322]);
    expect(hueForSeriesSlot(10)).toBe(251);
  });
});
