import { describe, expect, it } from 'vitest';

import { HEX_RE, blendHex, contrastRatio, hexToRgb, hsvToRgb, readableTone, rgbToHex, rgbToHsv } from '../../src/lib/color';

describe('HEX_RE', () => {
  it('accepts 6-digit hex in either case', () => {
    expect(HEX_RE.test('#00E5FF')).toBe(true);
    expect(HEX_RE.test('#00e5ff')).toBe(true);
    expect(HEX_RE.test('#ABCDEF')).toBe(true);
  });

  it('rejects 3-digit shorthand', () => {
    expect(HEX_RE.test('#F00')).toBe(false);
  });

  it('rejects 8-digit RGBA', () => {
    expect(HEX_RE.test('#00E5FFAA')).toBe(false);
  });

  it('rejects the empty string and missing hash', () => {
    expect(HEX_RE.test('')).toBe(false);
    expect(HEX_RE.test('00E5FF')).toBe(false);
  });

  it('rejects non-hex characters', () => {
    expect(HEX_RE.test('#GGGGGG')).toBe(false);
    expect(HEX_RE.test('#00 5FF')).toBe(false);
  });
});

describe('hexToRgb', () => {
  it('parses uppercase and lowercase to the same tuple', () => {
    expect(hexToRgb('#00E5FF')).toEqual([0, 229, 255]);
    expect(hexToRgb('#00e5ff')).toEqual([0, 229, 255]);
  });

  it('parses the black and white boundaries', () => {
    expect(hexToRgb('#000000')).toEqual([0, 0, 0]);
    expect(hexToRgb('#FFFFFF')).toEqual([255, 255, 255]);
  });

  it('returns null on invalid hex (guards HSV seed against undefined)', () => {
    expect(hexToRgb('#F00')).toBeNull();
    expect(hexToRgb('#XYZXYZ')).toBeNull();
    expect(hexToRgb('')).toBeNull();
  });
});

describe('rgbToHex', () => {
  it('formats as uppercase #RRGGBB', () => {
    expect(rgbToHex(0, 229, 255)).toBe('#00E5FF');
    expect(rgbToHex(139, 92, 246)).toBe('#8B5CF6');
  });

  it('zero-pads single-digit hex bytes', () => {
    expect(rgbToHex(0, 0, 0)).toBe('#000000');
    expect(rgbToHex(1, 2, 3)).toBe('#010203');
    expect(rgbToHex(255, 255, 255)).toBe('#FFFFFF');
  });
});

describe('rgbToHsv', () => {
  it('gives value=0 and saturation=0 for black', () => {
    const [, s, v] = rgbToHsv(0, 0, 0);
    expect(v).toBe(0);
    expect(s).toBe(0);
  });

  it('gives value=1 and saturation=0 for white', () => {
    const [, s, v] = rgbToHsv(255, 255, 255);
    expect(v).toBe(1);
    expect(s).toBe(0);
  });

  it('gives hue=0 for pure red', () => {
    const [h, s, v] = rgbToHsv(255, 0, 0);
    expect(h).toBe(0);
    expect(s).toBe(1);
    expect(v).toBe(1);
  });

  it('gives hue=120 for pure green and hue=240 for pure blue', () => {
    expect(rgbToHsv(0, 255, 0)[0]).toBe(120);
    expect(rgbToHsv(0, 0, 255)[0]).toBe(240);
  });
});

describe('hsvToRgb', () => {
  it('round-trips through six hue anchors (0/60/120/180/240/300)', () => {
    expect(hsvToRgb(0, 1, 1)).toEqual([255, 0, 0]);
    expect(hsvToRgb(60, 1, 1)).toEqual([255, 255, 0]);
    expect(hsvToRgb(120, 1, 1)).toEqual([0, 255, 0]);
    expect(hsvToRgb(180, 1, 1)).toEqual([0, 255, 255]);
    expect(hsvToRgb(240, 1, 1)).toEqual([0, 0, 255]);
    expect(hsvToRgb(300, 1, 1)).toEqual([255, 0, 255]);
  });

  it('gives black when value=0 regardless of hue/saturation', () => {
    expect(hsvToRgb(0, 0, 0)).toEqual([0, 0, 0]);
    expect(hsvToRgb(180, 1, 0)).toEqual([0, 0, 0]);
  });

  it('gives grayscale when saturation=0', () => {
    expect(hsvToRgb(0, 0, 1)).toEqual([255, 255, 255]);
    expect(hsvToRgb(180, 0, 0.5)).toEqual([128, 128, 128]);
  });
});

describe('HSV/RGB/HEX round-trip', () => {
  it('rgb -> hsv -> rgb is near-identity for sample colors', () => {
    const samples: [number, number, number][] = [
      [0, 229, 255],
      [139, 92, 246],
      [16, 185, 129],
      [244, 63, 94],
      [251, 191, 36],
    ];
    for (const [r, g, b] of samples) {
      const [h, s, v] = rgbToHsv(r, g, b);
      const [r2, g2, b2] = hsvToRgb(h, s, v);
      expect(Math.abs(r2 - r)).toBeLessThanOrEqual(1);
      expect(Math.abs(g2 - g)).toBeLessThanOrEqual(1);
      expect(Math.abs(b2 - b)).toBeLessThanOrEqual(1);
    }
  });

  it('hex -> rgb -> hex is exact for canonical uppercase input', () => {
    for (const hex of ['#000000', '#FFFFFF', '#00E5FF', '#8B5CF6', '#F43F5E']) {
      const rgb = hexToRgb(hex);
      expect(rgb).not.toBeNull();
      expect(rgbToHex(...rgb!)).toBe(hex);
    }
  });
});

describe('readableTone', () => {
  // The component resolves the label against the chip's own fill -- 10% of the
  // hue over the card -- so the tests ask the same question it does.
  const chip = (hue: string, card: string) => blendHex(hue, 0.1, card);
  const CARD_LIGHT = '#FFFFFF';
  const CARD_DARK = '#373737';
  const ratio = (hex: string, surface: string) =>
    contrastRatio(hexToRgb(hex)!, hexToRgb(surface)!);
  const toned = (hue: string, card: string) => readableTone(hue, chip(hue, card));

  it('returns the colour untouched when it already reads', () => {
    // A deep blue is already well past the floor on its own chip.
    expect(toned('#00306E', CARD_LIGHT)).toBe('#00306E');
  });

  it('darkens a mid hue for a light surface and lightens it for a dark one', () => {
    const light = toned('#C239B3', CARD_LIGHT);
    const dark = toned('#C239B3', CARD_DARK);
    expect(ratio('#C239B3', chip('#C239B3', CARD_LIGHT))).toBeLessThan(4.5);
    expect(ratio('#C239B3', chip('#C239B3', CARD_DARK))).toBeLessThan(4.5);
    expect(ratio(light, chip('#C239B3', CARD_LIGHT))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(dark, chip('#C239B3', CARD_DARK))).toBeGreaterThanOrEqual(4.5);
    expect(hexToRgb(light)![0]).toBeLessThan(hexToRgb('#C239B3')![0]);
    expect(hexToRgb(dark)![0]).toBeGreaterThan(hexToRgb('#C239B3')![0]);
  });

  it('holds the hue while it moves value', () => {
    const [sourceHue] = rgbToHsv(...hexToRgb('#00E5FF')!);
    const [tonedHue] = rgbToHsv(...hexToRgb(toned('#00E5FF', CARD_LIGHT))!);
    expect(Math.abs(tonedHue - sourceHue)).toBeLessThan(1);
  });

  it('gives up saturation for the hues value alone cannot carry', () => {
    // A saturated yellow cannot reach 4.5 against a near-white surface at any
    // value, so the search has to desaturate rather than return the floor miss.
    const result = toned('#FFD740', CARD_LIGHT);
    expect(ratio(result, chip('#FFD740', CARD_LIGHT))).toBeGreaterThanOrEqual(4.5);
    const [, sourceSaturation] = rgbToHsv(...hexToRgb('#FFD740')!);
    const [, resultSaturation] = rgbToHsv(...hexToRgb(result)!);
    expect(resultSaturation).toBeLessThan(sourceSaturation);
  });

  it('reaches the floor for every preset the picker offers, in both schemes', () => {
    for (const preset of ['#FFD740', '#00E676', '#00E5FF', '#A78BFA', '#FF5252', '#FF9800']) {
      for (const card of [CARD_LIGHT, CARD_DARK]) {
        expect(ratio(toned(preset, card), chip(preset, card))).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('leaves a value it cannot parse alone', () => {
    expect(readableTone('not a colour', CARD_LIGHT)).toBe('not a colour');
  });
});

describe('blendHex', () => {
  it('returns the backdrop at zero alpha and the top colour at one', () => {
    expect(blendHex('#FF0000', 0, '#FFFFFF')).toBe('#FFFFFF');
    expect(blendHex('#FF0000', 1, '#FFFFFF')).toBe('#FF0000');
  });

  it('composites a tenth of the hue onto both cards', () => {
    expect(blendHex('#C239B3', 0.1, '#FFFFFF')).toBe('#F9EBF7');
    expect(blendHex('#C239B3', 0.1, '#373737')).toBe('#453743');
  });

  it('falls back to the backdrop when either side is unparseable', () => {
    expect(blendHex('nope', 0.5, '#FFFFFF')).toBe('#FFFFFF');
  });
});
