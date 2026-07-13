import { describe, expect, it } from 'vitest';

import { clamp01, HEX_RE, hexToRgb, hsvToRgb, rgbToHex, rgbToHsv } from './color.ts';

describe('clamp01', () => {
  it('clamps negatives to 0 and >1 to 1; passes middle through', () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(0)).toBe(0);
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(1)).toBe(1);
    expect(clamp01(2)).toBe(1);
  });
});

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
