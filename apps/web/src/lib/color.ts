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
type RgbTuple = [number, number, number];

registerMode(modeRgb);

const rgbTuple = ({ r, g, b }: { r: number; g: number; b: number }): RgbTuple =>
  [r, g, b].map(channel => Math.round(channel * 255)) as RgbTuple;

const parseRgb = (hex: string) => {
  if (!HEX_RE.test(hex)) throw new TypeError(`Not a #RRGGBB colour: ${hex}`);
  return parseHex(hex)!;
};

export const hexToRgb = (hex: string): RgbTuple => rgbTuple(parseRgb(hex));

const linearRgb = (rgb: ReturnType<typeof parseRgb>) => convertRgbToLrgb(rgb);
const colorHex = (rgb: ReturnType<typeof convertHsvToRgb>): string => formatHex(rgb).toUpperCase();

export const blendHex = (hex: string, alpha: number, backdrop: string): string => {
  const foreground = { ...parseRgb(hex), alpha };
  return formatHex(blend([parseRgb(backdrop), foreground], 'normal', 'rgb')).toUpperCase();
};

// WCAG 2.2 requires at least 4.5:1 contrast for normal text.
// https://www.w3.org/TR/WCAG22/#contrast-minimum
const TEXT_CONTRAST_FLOOR = 4.5;
const BLACK = parseRgb('#000000');
const WHITE = parseRgb('#FFFFFF');

/**
 * The nearest tone of `hex` that reads as text on `surface`. Hue is held fixed
 * because it carries the upstream's identity; value moves first because it costs
 * the least recognition, and saturation gives way only where value alone cannot
 * reach the floor.
 */
export const readableTone = (hex: string, surface: string): string => {
  const rgb = parseRgb(hex);
  const surfaceRgb = parseRgb(surface);
  const surfaceLinear = linearRgb(surfaceRgb);
  if (wcagContrast(linearRgb(rgb), surfaceLinear) >= TEXT_CONTRAST_FLOOR) return hex;

  const { h, s, v } = convertRgbToHsv(rgb);
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
    let readable: string | undefined;
    while (first <= last) {
      const step = Math.floor((first + last) / 2);
      const value = darken ? v * (1 - step / STEPS) : v + (1 - v) * (step / STEPS);
      const candidate = convertHsvToRgb({ h, s: saturation, v: value });
      const candidateHex = colorHex(candidate);
      if (wcagContrast(linearRgb(parseRgb(candidateHex)), surfaceLinear) >= TEXT_CONTRAST_FLOOR) {
        readable = candidateHex;
        last = step - 1;
      } else {
        first = step + 1;
      }
    }
    if (readable) return readable;
  }
  // Reachable: the saturation ladder stops short of zero unless the saturation is
  // a multiple of a tenth. The extreme always clears -- a surface's ratios against
  // black and white multiply to exactly 21, so the larger is never below 4.58.
  return formatHex(darken ? BLACK : WHITE).toUpperCase();
};
