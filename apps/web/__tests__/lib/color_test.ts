import { convertRgbToHsv, parseHex } from 'culori/fn';
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
    expect(() => readableTone('#0008', '#FFFFFF80')).toThrow('Readable tone requires an opaque surface');
  });

  it('gives up saturation for the hue brightening cannot carry', () => {
    // A fully saturated blue reads 1.44:1 on its own chip at full value, and its
    // channels are already at their limit, so the search has to desaturate.
    const result = toned('#0000FF', CARD_DARK);
    expect(contrast('#0000FF', chip('#0000FF', CARD_DARK))).toBeLessThan(1.5);
    expect(contrast(result, chip('#0000FF', CARD_DARK))).toBeGreaterThanOrEqual(4.5);
    const { s: sourceSaturation } = convertRgbToHsv(parseHex('#0000FF')!);
    const { s: resultSaturation } = convertRgbToHsv(parseHex(result)!);
    expect(resultSaturation).toBeLessThan(sourceSaturation);
  });

  it('reaches the floor for every tone a hue can produce, in both schemes', () => {
    for (let hue = 0; hue < 360; hue += 1) {
      const tone = hueBadgeTone(hue);
      expect(contrast(toned(tone.light, CARD_LIGHT), chip(tone.light, CARD_LIGHT))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(toned(tone.dark, CARD_DARK), chip(tone.dark, CARD_DARK))).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('blendHex', () => {
  it('rejects an unparseable value on either side', () => {
    expect(() => blendHex('nope', 0.5, '#FFFFFF')).toThrow(TypeError);
    expect(() => blendHex('#FF0000', 0.5, 'nope')).toThrow(TypeError);
    expect(() => blendHex('#FF0000', 0.5, '#0000')).toThrow('Hex blending requires an opaque backdrop');
  });
});

describe('readableTone on a mid surface', () => {
  it('is total: every hue against every grey surface yields a well-formed hex', () => {
    // The search moves in two directions and gives up saturation in a loop, so
    // the property worth holding is that no input escapes it malformed.
    const hues: string[] = [];
    for (let r = 0; r <= 255; r += 51) {
      for (let g = 0; g <= 255; g += 51) {
        for (let b = 0; b <= 255; b += 51) {
          hues.push(`#${[r, g, b].map(n => n.toString(16).padStart(2, '0')).join('').toUpperCase()}`);
        }
      }
    }
    for (let level = 0; level <= 255; level += 15) {
      const surface = `#${level.toString(16).padStart(2, '0').repeat(3).toUpperCase()}`;
      for (const hue of hues) expect(readableTone(hue, surface)).toMatch(/^#[0-9A-F]{6}$/);
    }
  });

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
