import {
  blend,
  convertHsvToRgb,
  convertRgbToHsv,
  convertRgbToLrgb,
  formatHex,
  modeRgb,
  parseHex,
  useMode as registerMode,
  wcagContrast,
} from 'culori/fn';

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
export type RgbTuple = [number, number, number];

registerMode(modeRgb);

const rgbTuple = ({ r, g, b }: { r: number; g: number; b: number }): RgbTuple =>
  [r, g, b].map(channel => Math.round(channel * 255)) as RgbTuple;

const rgbColor = ([r, g, b]: RgbTuple) => ({ mode: 'rgb' as const, r: r / 255, g: g / 255, b: b / 255 });

const parseRgb = (hex: string) => {
  if (!HEX_RE.test(hex)) throw new TypeError(`Not a #RRGGBB colour: ${hex}`);
  return parseHex(hex)!;
};

export const hexToRgb = (hex: string): RgbTuple => rgbTuple(parseRgb(hex));

export const rgbToHex = (r: number, g: number, b: number): string =>
  formatHex(rgbColor([r, g, b])).toUpperCase();

export const rgbToHsv = (r: number, g: number, b: number): [number, number, number] => {
  const { h, s, v } = convertRgbToHsv(rgbColor([r, g, b]));
  return [h ?? 0, s, v];
};

export const hsvToRgb = (h: number, s: number, v: number): RgbTuple =>
  rgbTuple(convertHsvToRgb({ mode: 'hsv', h, s, v }));

const linearRgb = (rgb: RgbTuple) => convertRgbToLrgb(rgbColor(rgb));

export const blendHex = (hex: string, alpha: number, backdrop: string): string => {
  const foreground = { ...parseRgb(hex), alpha };
  return formatHex(blend([parseRgb(backdrop), foreground], 'normal', 'rgb')).toUpperCase();
};

// WCAG 2.2 requires at least 4.5:1 contrast for normal text.
// https://www.w3.org/TR/WCAG22/#contrast-minimum
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
  const surfaceLinear = linearRgb(surfaceRgb);
  if (wcagContrast(linearRgb(rgb), surfaceLinear) >= TEXT_CONTRAST_FLOOR) return hex;

  const [h, s, v] = rgbToHsv(...rgb);
  // Which extreme actually clears the floor, not whether the surface is light:
  // between luminance 0.183 and 0.5 white misses the floor while black clears
  // it, so a lightness test would search the direction that cannot arrive.
  const darken = wcagContrast(linearRgb(BLACK), surfaceLinear) > wcagContrast(linearRgb(WHITE), surfaceLinear);
  const STEPS = 100;

  for (let saturation = s; saturation >= 0; saturation -= 0.1) {
    // Luminance is monotonic as HSV value moves toward the chosen black/white
    // extreme, so this finds the same first rung as a linear walk of all 100.
    let first = 1;
    let last = STEPS;
    let readable: RgbTuple | undefined;
    while (first <= last) {
      const step = Math.floor((first + last) / 2);
      const value = darken ? v * (1 - step / STEPS) : v + (1 - v) * (step / STEPS);
      const candidate = hsvToRgb(h, saturation, value);
      if (wcagContrast(linearRgb(candidate), surfaceLinear) >= TEXT_CONTRAST_FLOOR) {
        readable = candidate;
        last = step - 1;
      } else {
        first = step + 1;
      }
    }
    if (readable) return rgbToHex(...readable);
  }
  // Reachable: the saturation ladder stops short of zero unless the saturation is
  // a multiple of a tenth. The extreme always clears -- a surface's ratios against
  // black and white multiply to exactly 21, so the larger is never below 4.58.
  return rgbToHex(...(darken ? BLACK : WHITE));
};
