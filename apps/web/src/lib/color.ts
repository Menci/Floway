// Uppercase-or-lowercase #RRGGBB only; shorthand and 8-digit alpha are not
// forms anything here writes.
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

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

// Everything that composites holds a colour this module or the schema already
// produced, so an unparseable value is a fault rather than a shade to invent.
export const hexToRgb = (hex: string): [number, number, number] => {
  if (!HEX_RE.test(hex)) throw new TypeError(`Not a #RRGGBB colour: ${hex}`);
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

// https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
const relativeLuminance = ([r, g, b]: [number, number, number]): number => {
  const channel = (value: number) => {
    const s = value / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};

const contrastRatio = (a: [number, number, number], b: [number, number, number]): number => {
  const [x, y] = [relativeLuminance(a) + 0.05, relativeLuminance(b) + 0.05];
  return x > y ? x / y : y / x;
};

export const blendHex = (hex: string, alpha: number, backdrop: string): string => {
  const top = hexToRgb(hex);
  const bottom = hexToRgb(backdrop);
  return rgbToHex(...(top.map((channel, index) =>
    Math.round(channel * alpha + bottom[index]! * (1 - alpha))) as [number, number, number]));
};

const TEXT_CONTRAST_FLOOR = 4.5;
const BLACK: [number, number, number] = [0, 0, 0];
const WHITE: [number, number, number] = [255, 255, 255];

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
