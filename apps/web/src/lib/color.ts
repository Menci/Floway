// Colour math the dashboard needs outside a component: the HSV / RGB / HEX
// conversions the upstream colour picker edits in, and the WCAG contrast the
// provider badge resolves an operator-chosen hue against. Kept here so the math
// is unit-testable without rendering, and so any later surface that has to
// place text on a colour a person picked can share the same primitives.
//
// HSV coordinates: hue in [0, 360), saturation/value in [0, 1]. HEX is
// the canonical wire form (`#RRGGBB`, upper-or-lower case accepted).

import { UPSTREAM_COLOR_HEX_REGEX } from '@floway-dev/provider/model';

// Alias for the canonical wire regex so the picker validates hex against
// the same rule the control-plane schema enforces.
export const HEX_RE = UPSTREAM_COLOR_HEX_REGEX;

export const hsvToRgb = (h: number, s: number, v: number): [number, number, number] => {
  const c = v * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp >= 0 && hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = v - c;
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
};

export const rgbToHex = (r: number, g: number, b: number): string =>
  `#${  [r, g, b].map(n => n.toString(16).padStart(2, '0')).join('').toUpperCase()}`;

export const hexToRgb = (hex: string): [number, number, number] | null => {
  if (!HEX_RE.test(hex)) return null;
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
};

export const rgbToHsv = (r: number, g: number, b: number): [number, number, number] => {
  const rf = r / 255, gf = g / 255, bf = b / 255;
  const max = Math.max(rf, gf, bf), min = Math.min(rf, gf, bf);
  const d = max - min;
  const v = max;
  const s = max === 0 ? 0 : d / max;
  let h = 0;
  if (d !== 0) {
    if (max === rf) h = ((gf - bf) / d + (gf < bf ? 6 : 0)) * 60;
    else if (max === gf) h = ((bf - rf) / d + 2) * 60;
    else h = ((rf - gf) / d + 4) * 60;
  }
  return [h, s, v];
};

// WCAG 2.x relative luminance and contrast, over sRGB.
const relativeLuminance = ([r, g, b]: [number, number, number]): number => {
  const channel = (value: number) => {
    const s = value / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};

export const contrastRatio = (a: [number, number, number], b: [number, number, number]): number => {
  const [x, y] = [relativeLuminance(a) + 0.05, relativeLuminance(b) + 0.05];
  return x > y ? x / y : y / x;
};

/** `hex` at `alpha` composited over `backdrop`, both opaque, as a new hex. */
export const blendHex = (hex: string, alpha: number, backdrop: string): string => {
  const top = hexToRgb(hex);
  const bottom = hexToRgb(backdrop);
  if (!top || !bottom) return backdrop;
  return rgbToHex(...(top.map((channel, index) =>
    Math.round(channel * alpha + bottom[index]! * (1 - alpha))) as [number, number, number]));
};

const TEXT_CONTRAST_FLOOR = 4.5;

/**
 * The nearest tone of `hex` that reads as text on `surface`, found by moving
 * HSV value toward or away from the surface and only then desaturating.
 *
 * A colour a person picked for an upstream is an identity, not a foreground:
 * it is chosen against whichever scheme that person happened to be in, and the
 * same literal then has to label a chip on a near-white card and on a near-black
 * one. Hue is what carries the identity, so hue is what this holds fixed; value
 * moves first because it costs the least recognition, and saturation gives way
 * only for the hues where value alone cannot get there — a saturated yellow
 * cannot reach 4.5 against white at any value.
 */
export const readableTone = (hex: string, surface: string): string => {
  const rgb = hexToRgb(hex);
  const surfaceRgb = hexToRgb(surface);
  if (!rgb || !surfaceRgb) return hex;
  if (contrastRatio(rgb, surfaceRgb) >= TEXT_CONTRAST_FLOOR) return hex;

  const [h, s, v] = rgbToHsv(...rgb);
  const darken = relativeLuminance(surfaceRgb) > 0.5;
  const STEPS = 100;

  for (let saturation = s; ; saturation -= 0.1) {
    for (let step = 1; step <= STEPS; step += 1) {
      const value = darken ? v * (1 - step / STEPS) : v + (1 - v) * (step / STEPS);
      const candidate = hsvToRgb(h, saturation, value);
      if (contrastRatio(candidate, surfaceRgb) >= TEXT_CONTRAST_FLOOR) return rgbToHex(...candidate);
    }
    // Value is exhausted in the useful direction. Below zero saturation the
    // colour is grey and further loops cannot help, so the extreme is the
    // answer: black on a light surface, white on a dark one.
    if (saturation <= 0) return darken ? '#000000' : '#FFFFFF';
  }
};
