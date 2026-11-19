import { parseHex } from 'culori/fn';
import { describe, expect, it } from 'vitest';

import { blendHex, readableTone } from '../../src/lib/color';
import { hueBadgeTone } from '../../src/lib/hue';

// The subject decides by contrast, so the assertions compute it independently
// rather than borrowing the function under test.
const contrast = (a: string, b: string) => {
  const luminance = (hex: string) => {
    const { r, g, b } = parseHex(hex)!;
    const channel = (value: number) => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };
  const [x, y] = [luminance(a) + 0.05, luminance(b) + 0.05];
  return x > y ? x / y : y / x;
};

describe('readableTone', () => {
  // The component resolves the label against the chip's own fill -- 10% of the
  // hue over the card -- so the tests ask the same question it does.
  const chip = (hue: string, card: string) => blendHex(hue, 0.1, card);
  const CARD_LIGHT = '#FFFFFF';
  const CARD_DARK = '#373737';
  const toned = (hue: string, card: string) => readableTone(hue, chip(hue, card));

  it('measures alpha colors after compositing them onto the surface', () => {
    const result = readableTone('#00000080', CARD_LIGHT);
    expect(result).not.toBe('#00000080');
    expect(contrast(result, CARD_LIGHT)).toBeGreaterThanOrEqual(4.5);
  });

  it('rejects a translucent surface without a backdrop to flatten it onto', () => {
    expect(() => readableTone('#0008', '#FFFFFF80')).toThrow(TypeError);
  });

  it('reaches the floor for every tone a hue can produce, in both schemes', () => {
    for (let hue = 0; hue < 360; hue += 1) {
      const tone = hueBadgeTone(hue);
      expect(contrast(toned(tone.light, CARD_LIGHT), chip(tone.light, CARD_LIGHT))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(toned(tone.dark, CARD_DARK), chip(tone.dark, CARD_DARK))).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('readableTone on a mid surface', () => {
  it('moves toward whichever extreme clears the floor, not toward the darker one', () => {
    // Between luminance 0.183 and 0.5 white misses 4.5 and black clears it, so
    // a light-versus-dark test would search the direction that cannot arrive.
    const surface = '#787878';
    expect(contrast('#FFFFFF', surface)).toBeLessThan(4.5);
    expect(contrast('#000000', surface)).toBeGreaterThanOrEqual(4.5);
    const result = readableTone('#0000FF', surface);
    expect(contrast(result, surface)).toBeGreaterThanOrEqual(4.5);
  });
});
