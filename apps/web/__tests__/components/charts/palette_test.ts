import { describe, expect, it } from 'vitest';

import { colorForHue, hueForSeriesSlot } from '../../../src/components/charts/palette';

describe('chart series colors', () => {
  it('calculates fixed-lightness, fixed-chroma hues as sRGB hex', () => {
    expect(colorForHue(0)).toBe('#df7a9b');
    expect(colorForHue(217)).toBe('#00b1d3');
    for (let hue = 0; hue < 360; hue += 1) {
      expect(colorForHue(hue), `${hue}deg`).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('keeps the original palette identities as a repeating hue sequence', () => {
    expect(Array.from({ length: 10 }, (_, slot) => hueForSeriesSlot(slot)))
      .toEqual([251, 144, 10, 46, 302, 198, 54, 250, 128, 322]);
    expect(hueForSeriesSlot(10)).toBe(251);
  });
});
