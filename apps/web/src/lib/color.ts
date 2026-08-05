import {
  blend,
  convertHsvToRgb,
  convertRgbToHsv,
  convertRgbToLrgb,
  formatHex,
  formatHex8,
  modeRgb,
  parseHex,
  useMode as registerMode,
  wcagContrast,
} from 'culori/fn';

registerMode(modeRgb);

const parseHexColor = (hex: string) => {
  const rgb = parseHex(hex);
  if (!rgb) throw new TypeError(`Not a hex colour: ${hex}`);
  return rgb;
};

const linearRgb = (rgb: ReturnType<typeof parseHexColor>) => convertRgbToLrgb(rgb);

export const alphaHex = (hex: string, opacity: number): string => {
  const rgb = parseHexColor(hex);
  return formatHex8({ ...rgb, alpha: (rgb.alpha ?? 1) * opacity }).toUpperCase();
};

export const blendHex = (hex: string, alpha: number, backdrop: string): string => {
  const parsed = parseHexColor(hex);
  const foreground = { ...parsed, alpha: (parsed.alpha ?? 1) * alpha };
  const mixed = blend([parseHexColor(backdrop), foreground], 'normal', 'rgb');
  if (mixed.alpha === undefined) throw new TypeError('Culori blend returned no alpha');
  return (mixed.alpha < 1 ? formatHex8(mixed) : formatHex(mixed)).toUpperCase();
};

// WCAG 2.2 requires at least 4.5:1 contrast for normal text.
// https://www.w3.org/TR/WCAG22/#contrast-minimum
const TEXT_CONTRAST_FLOOR = 4.5;
const BLACK = parseHexColor('#000000');
const WHITE = parseHexColor('#FFFFFF');

/**
 * The nearest tone of `hex` that reads as text on `surface`. Hue is held fixed
 * because it carries the upstream's identity; value moves first because it costs
 * the least recognition, and saturation gives way only where value alone cannot
 * reach the floor.
 */
export const readableTone = (hex: string, surface: string): string => {
  const rgb = parseHexColor(hex);
  const surfaceRgb = parseHexColor(surface);
  if (surfaceRgb.alpha !== undefined && surfaceRgb.alpha < 1) {
    throw new TypeError('Readable tone requires an opaque surface');
  }
  const surfaceLinear = linearRgb(surfaceRgb);
  const paintedRgb = blend([surfaceRgb, rgb], 'normal', 'rgb') as ReturnType<typeof parseHexColor>;
  if (wcagContrast(linearRgb(paintedRgb), surfaceLinear) >= TEXT_CONTRAST_FLOOR) return hex;

  const opaqueHex = formatHex(rgb).toUpperCase();
  if (wcagContrast(linearRgb(parseHexColor(opaqueHex)), surfaceLinear) >= TEXT_CONTRAST_FLOOR) return opaqueHex;

  const { h, s, v } = convertRgbToHsv(rgb);
  // Which extreme actually clears the floor, not whether the surface is light:
  // between luminance 0.183 and 0.5 white misses the floor while black clears
  // it, so a lightness test would search the direction that cannot arrive.
  const darken = wcagContrast(linearRgb(BLACK), surfaceLinear) > wcagContrast(linearRgb(WHITE), surfaceLinear);
  const STEPS = 100;

  for (let saturation = s; saturation >= 0; saturation -= 0.1) {
    // Luminance is monotonic along the chosen HSV value direction, so this
    // finds the same first rung as a linear walk of all 100.
    let first = 1;
    let last = STEPS;
    let readable: string | undefined;
    while (first <= last) {
      const step = Math.floor((first + last) / 2);
      const value = darken ? v * (1 - step / STEPS) : v + (1 - v) * (step / STEPS);
      const candidate = convertHsvToRgb({ h, s: saturation, v: value });
      const candidateHex = formatHex(candidate).toUpperCase();
      if (wcagContrast(linearRgb(parseHexColor(candidateHex)), surfaceLinear) >= TEXT_CONTRAST_FLOOR) {
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
