import { convertRgbToHsv, parseHex } from 'culori/fn';
import { describe, expect, it } from 'vitest';

import { alphaHex, blendHex, readableTone } from '../../src/lib/color';
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

  it('returns the colour untouched when it already reads', () => {
    // A deep blue is already well past the floor on its own chip.
    expect(toned('#00306E', CARD_LIGHT)).toBe('#00306E');
  });

  it('measures alpha colors after compositing them onto the surface', () => {
    const result = readableTone('#00000080', CARD_LIGHT);
    expect(result).not.toBe('#00000080');
    expect(contrast(result, CARD_LIGHT)).toBeGreaterThanOrEqual(4.5);
  });

  it('checks the same opaque tone before searching away from an alpha color', () => {
    expect(readableTone('#00001110', '#757575')).toBe('#000011');
  });

  it('rejects a translucent surface without a backdrop to flatten it onto', () => {
    expect(() => readableTone('#0008', '#FFFFFF80')).toThrow('Readable tone requires an opaque surface');
  });

  it('darkens a mid hue for a light surface and lightens it for a dark one', () => {
    const light = toned('#C239B3', CARD_LIGHT);
    const dark = toned('#C239B3', CARD_DARK);
    expect(contrast('#C239B3', chip('#C239B3', CARD_LIGHT))).toBeLessThan(4.5);
    expect(contrast('#C239B3', chip('#C239B3', CARD_DARK))).toBeLessThan(4.5);
    expect(contrast(light, chip('#C239B3', CARD_LIGHT))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(dark, chip('#C239B3', CARD_DARK))).toBeGreaterThanOrEqual(4.5);
    expect(parseHex(light)!.r).toBeLessThan(parseHex('#C239B3')!.r);
    expect(parseHex(dark)!.r).toBeGreaterThan(parseHex('#C239B3')!.r);
  });

  it('holds the hue while it moves value', () => {
    const { h: sourceHue } = convertRgbToHsv(parseHex('#00E5FF')!);
    const { h: tonedHue } = convertRgbToHsv(parseHex(toned('#00E5FF', CARD_LIGHT))!);
    if (sourceHue === undefined || tonedHue === undefined) throw new TypeError('Expected chromatic colors');
    expect(Math.abs(tonedHue - sourceHue)).toBeLessThan(1);
  });

  it('reaches the floor on a light surface without giving up saturation', () => {
    // Darkening always works, because every hue reaches black. Even a saturated
    // yellow, which looks like the hard case, is solved by value alone.
    const result = toned('#FFD740', CARD_LIGHT);
    expect(contrast(result, chip('#FFD740', CARD_LIGHT))).toBeGreaterThanOrEqual(4.5);
    const { s: sourceSaturation } = convertRgbToHsv(parseHex('#FFD740')!);
    const { s: resultSaturation } = convertRgbToHsv(parseHex(result)!);
    expect(resultSaturation).toBeCloseTo(sourceSaturation, 1);
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

  it('rejects a value it cannot parse', () => {
    expect(() => readableTone('not a colour', CARD_LIGHT)).toThrow(TypeError);
  });
});

describe('blendHex', () => {
  it('accepts Culori hex forms', () => {
    expect(blendHex('#f00', 1, '#fff')).toBe('#FF0000');
    expect(blendHex('#f00', 0, '#0000')).toBe('#00000000');
    expect(blendHex('#ff000080', 0.5, '#0000')).toBe('#FF000040');
  });

  it('returns the backdrop at zero alpha and the top colour at one', () => {
    expect(blendHex('#FF0000', 0, '#FFFFFF')).toBe('#FFFFFF');
    expect(blendHex('#FF0000', 1, '#FFFFFF')).toBe('#FF0000');
  });

  it('composites a tenth of the hue onto both cards', () => {
    expect(blendHex('#C239B3', 0.1, '#FFFFFF')).toBe('#F9EBF7');
    expect(blendHex('#C239B3', 0.1, '#373737')).toBe('#453743');
  });

  it('rejects an unparseable value on either side', () => {
    expect(() => blendHex('nope', 0.5, '#FFFFFF')).toThrow(TypeError);
    expect(() => blendHex('#FF0000', 0.5, 'nope')).toThrow(TypeError);
  });
});

describe('alphaHex', () => {
  it('serializes the combined opacity through Culori', () => {
    expect(alphaHex('#0000006B', 0.1)).toBe('#0000000B');
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
