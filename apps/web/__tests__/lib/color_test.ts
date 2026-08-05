import { describe, expect, it } from 'vitest';

import { blendHex, hexToRgb, hsvToRgb, readableTone, rgbToHex, rgbToHsv } from '../../src/lib/color';
import { hueBadgeTone } from '../../src/lib/hue';

// The subject decides by contrast, so the assertions compute it independently
// rather than borrowing the function under test.
const contrast = (a: string, b: string) => {
  const luminance = (hex: string) => {
    const [r, g, b2] = hexToRgb(hex);
    const channel = (value: number) => {
      const s = value / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b2);
  };
  const [x, y] = [luminance(a) + 0.05, luminance(b) + 0.05];
  return x > y ? x / y : y / x;
};

describe('hexToRgb', () => {
  it('rejects everything that is not 6-digit hex', () => {
    for (const value of ['#F00', '#00E5FFAA', '', '00E5FF', '#GGGGGG', '#00 5FF', '#XYZXYZ']) {
      expect(() => hexToRgb(value), value).toThrow(TypeError);
    }
  });

  it('parses uppercase and lowercase to the same tuple', () => {
    expect(hexToRgb('#00E5FF')).toEqual([0, 229, 255]);
    expect(hexToRgb('#00e5ff')).toEqual([0, 229, 255]);
  });

  it('parses the black and white boundaries', () => {
    expect(hexToRgb('#000000')).toEqual([0, 0, 0]);
    expect(hexToRgb('#FFFFFF')).toEqual([255, 255, 255]);
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
  it('keeps the public zero-hue convention for achromatic colors', () => {
    const [h, s, v] = rgbToHsv(0, 0, 0);
    expect(h).toBe(0);
    expect(v).toBe(0);
    expect(s).toBe(0);
    expect(rgbToHsv(128, 128, 128)[0]).toBe(0);
  });

  it('gives value=1 and saturation=0 for white', () => {
    const [h, s, v] = rgbToHsv(255, 255, 255);
    expect(h).toBe(0);
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

  it.each([
    [1, 1, 1, [255, 4, 0]],
    [59, 1, 1, [255, 251, 0]],
    [119, 1, 1, [4, 255, 0]],
    [179, 1, 1, [0, 255, 251]],
    [239, 1, 1, [0, 4, 255]],
    [299, 1, 1, [251, 0, 255]],
    [359, 1, 1, [255, 0, 4]],
    [17, 0.41, 0.73, [186, 131, 110]],
    [73, 0.83, 0.57, [119, 145, 25]],
    [211, 0.67, 0.92, [77, 153, 235]],
    [318, 0.22, 0.31, [79, 62, 74]],
    [30, 1, 0.5, [128, 64, 0]],
    [210, 0.5, 0.5, [64, 96, 128]],
  ] as const)('preserves the frozen byte result for hsv(%s, %s, %s)', (h, s, v, expected) => {
    expect(hsvToRgb(h, s, v)).toEqual(expected);
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
      expect(rgbToHex(...hexToRgb(hex))).toBe(hex);
    }
  });
});

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

  it('darkens a mid hue for a light surface and lightens it for a dark one', () => {
    const light = toned('#C239B3', CARD_LIGHT);
    const dark = toned('#C239B3', CARD_DARK);
    expect(contrast('#C239B3', chip('#C239B3', CARD_LIGHT))).toBeLessThan(4.5);
    expect(contrast('#C239B3', chip('#C239B3', CARD_DARK))).toBeLessThan(4.5);
    expect(contrast(light, chip('#C239B3', CARD_LIGHT))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(dark, chip('#C239B3', CARD_DARK))).toBeGreaterThanOrEqual(4.5);
    expect(hexToRgb(light)[0]).toBeLessThan(hexToRgb('#C239B3')[0]);
    expect(hexToRgb(dark)[0]).toBeGreaterThan(hexToRgb('#C239B3')[0]);
  });

  it('holds the hue while it moves value', () => {
    const [sourceHue] = rgbToHsv(...hexToRgb('#00E5FF'));
    const [tonedHue] = rgbToHsv(...hexToRgb(toned('#00E5FF', CARD_LIGHT)));
    expect(Math.abs(tonedHue - sourceHue)).toBeLessThan(1);
  });

  it('reaches the floor on a light surface without giving up saturation', () => {
    // Darkening always works, because every hue reaches black. Even a saturated
    // yellow, which looks like the hard case, is solved by value alone.
    const result = toned('#FFD740', CARD_LIGHT);
    expect(contrast(result, chip('#FFD740', CARD_LIGHT))).toBeGreaterThanOrEqual(4.5);
    const [, sourceSaturation] = rgbToHsv(...hexToRgb('#FFD740'));
    const [, resultSaturation] = rgbToHsv(...hexToRgb(result));
    expect(resultSaturation).toBeCloseTo(sourceSaturation, 1);
  });

  it('gives up saturation for the hue brightening cannot carry', () => {
    // A fully saturated blue reads 1.44:1 on its own chip at full value, and its
    // channels are already at their limit, so the search has to desaturate.
    const result = toned('#0000FF', CARD_DARK);
    expect(contrast('#0000FF', chip('#0000FF', CARD_DARK))).toBeLessThan(1.5);
    expect(contrast(result, chip('#0000FF', CARD_DARK))).toBeGreaterThanOrEqual(4.5);
    const [, sourceSaturation] = rgbToHsv(...hexToRgb('#0000FF'));
    const [, resultSaturation] = rgbToHsv(...hexToRgb(result));
    expect(resultSaturation).toBeLessThan(sourceSaturation);
  });

  it.each([
    ['#C239B3', '#FFFFFF', '#C239B3'],
    ['#C239B3', '#373737', '#F962E8'],
    ['#FFD740', '#FFFFFF', '#8A7423'],
    ['#0000FF', '#373737', '#9999FF'],
    ['#0000FF', '#787878', '#000036'],
    ['#00E5FF', '#FFFFFF', '#008391'],
    ['#00E5FF', '#373737', '#00E5FF'],
    ['#00306E', '#FFFFFF', '#00306E'],
    ['#4CC2FF', '#2C2C2C', '#4CC2FF'],
    ['#10B981', '#808080', '#021C13'],
    ['#F43F5E', '#949494', '#551621'],
    ['#FBBF24', '#6E6E6E', '#FCF1D4'],
    ['#010203', '#FFFFFF', '#010203'],
    ['#FEFDFC', '#000000', '#FEFDFC'],
  ])('preserves the frozen readable tone for %s on %s', (hex, surface, expected) => {
    expect(readableTone(hex, surface)).toBe(expected);
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
  it('returns the backdrop at zero alpha and the top colour at one', () => {
    expect(blendHex('#FF0000', 0, '#FFFFFF')).toBe('#FFFFFF');
    expect(blendHex('#FF0000', 1, '#FFFFFF')).toBe('#FF0000');
  });

  it('composites a tenth of the hue onto both cards', () => {
    expect(blendHex('#C239B3', 0.1, '#FFFFFF')).toBe('#F9EBF7');
    expect(blendHex('#C239B3', 0.1, '#373737')).toBe('#453743');
  });

  it('preserves the byte-rounded alpha compositing boundary', () => {
    expect(blendHex('#010203', 0.5, '#040506')).toBe('#030405');
    expect(blendHex('#ABCDEF', 0.333, '#123456')).toBe('#456789');
    expect(blendHex('#4CC2FF', 0.21 - Number.EPSILON, '#2C2C2C')).toBe('#334B58');
    expect(blendHex('#4CC2FF', 0.21, '#2C2C2C')).toBe('#334C58');
    expect(blendHex('#4CC2FF', 0.21 + Number.EPSILON, '#2C2C2C')).toBe('#334C58');
  });

  it('rejects an unparseable value on either side', () => {
    expect(() => blendHex('nope', 0.5, '#FFFFFF')).toThrow(TypeError);
    expect(() => blendHex('#FF0000', 0.5, 'nope')).toThrow(TypeError);
  });
});

describe('readableTone on a mid surface', () => {
  it('never returns a malformed hex when saturation runs out', () => {
    // A grey surface is the case that exhausts the search: neither direction
    // clears the floor at full saturation, so the loop runs to its last pass,
    // where a saturation off by one step would overflow a channel past 255.
    for (const surface of ['#787878', '#808080', '#6E6E6E', '#949494']) {
      for (const hue of ['#0000FF', '#00FF00', '#FF0000', '#FFFF00']) {
        expect(readableTone(hue, surface)).toMatch(/^#[0-9A-F]{6}$/);
      }
    }
  });

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
