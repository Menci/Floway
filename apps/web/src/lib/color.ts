import { blend, formatHex, parseHex, toHsv, toRgb, wcagContrast } from './culori';

type RgbTuple = [number, number, number];

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

const rgbTuple = ({ r, g, b }: { r: number; g: number; b: number }): RgbTuple =>
  [r, g, b].map(channel => Math.round(channel * 255)) as RgbTuple;

const rgbColor = ([r, g, b]: RgbTuple) => ({ mode: 'rgb' as const, r: r / 255, g: g / 255, b: b / 255 });

export const hsvToRgb = (h: number, s: number, v: number): RgbTuple =>
  rgbTuple(toRgb({ mode: 'hsv', h, s, v })!);

export const rgbToHex = (r: number, g: number, b: number): string =>
  formatHex(rgbColor([r, g, b])).toUpperCase();

export const hexToRgb = (hex: string): RgbTuple => {
  if (!HEX_RE.test(hex)) throw new TypeError(`Not a #RRGGBB colour: ${hex}`);
  return rgbTuple(parseHex(hex)!);
};

export const rgbToHsv = (r: number, g: number, b: number): [number, number, number] => {
  const { h = 0, s, v } = toHsv(rgbColor([r, g, b]))!;
  return [h, s, v];
};

const contrastRatio = (a: RgbTuple, b: RgbTuple): number => wcagContrast(rgbColor(a), rgbColor(b));

export const blendHex = (hex: string, alpha: number, backdrop: string): string => {
  const top = hexToRgb(hex);
  const bottom = hexToRgb(backdrop);
  return formatHex(blend([rgbColor(bottom), { ...rgbColor(top), alpha }])).toUpperCase();
};

const TEXT_CONTRAST_FLOOR = 4.5;
const BLACK: RgbTuple = [0, 0, 0];
const WHITE: RgbTuple = [255, 255, 255];

/**
 * The nearest tone of `hex` that reads as text on `surface`. Hue is held fixed
 * because it carries the upstream's identity; value moves first because it costs
 * the least recognition, and saturation gives way only where value alone cannot
 * reach the floor.
 */
export const readableTone = (hex: string, surface: string): string => {
  const rgb = hexToRgb(hex);
  const surfaceRgb = hexToRgb(surface);
  if (contrastRatio(rgb, surfaceRgb) >= TEXT_CONTRAST_FLOOR) return hex;

  const [h, s, v] = rgbToHsv(...rgb);
  // Which extreme actually clears the floor, not whether the surface is light:
  // between luminance 0.183 and 0.5 white misses the floor while black clears
  // it, so a lightness test would search the direction that cannot arrive.
  const darken = contrastRatio(BLACK, surfaceRgb) > contrastRatio(WHITE, surfaceRgb);
  const STEPS = 100;

  for (let saturation = s; saturation >= 0; saturation -= 0.1) {
    for (let step = 1; step <= STEPS; step += 1) {
      const value = darken ? v * (1 - step / STEPS) : v + (1 - v) * (step / STEPS);
      const candidate = hsvToRgb(h, saturation, value);
      if (contrastRatio(candidate, surfaceRgb) >= TEXT_CONTRAST_FLOOR) return rgbToHex(...candidate);
    }
  }
  // Reachable: the saturation ladder stops short of zero unless the saturation is
  // a multiple of a tenth. The extreme always clears -- a surface's ratios against
  // black and white multiply to exactly 21, so the larger is never below 4.58.
  return rgbToHex(...(darken ? BLACK : WHITE));
};
