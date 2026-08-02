// Colour math the dashboard needs outside a component: the HSV / RGB / HEX
// conversions the upstream colour picker edits in, and the WCAG contrast the
// provider badge resolves an operator-chosen hue against. Kept here so the math
// is unit-testable without rendering.
//
// `badgeHueStyle` is the only caller of `blendHex` and `readableTone`. They
// stay exported for the unit tests, which pin the empirical reasoning written
// down at `readableTone` directly rather than through a rendered badge.
//
// HSV coordinates: hue in [0, 360), saturation/value in [0, 1]. HEX is
// the canonical wire form (`#RRGGBB`, upper-or-lower case accepted).

import { UPSTREAM_COLOR_HEX_REGEX } from '@floway-dev/provider/model';
import type { UpstreamColor } from '@floway-dev/provider/model';

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

const contrastRatio = (a: [number, number, number], b: [number, number, number]): number => {
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
const BLACK: [number, number, number] = [0, 0, 0];
const WHITE: [number, number, number] = [255, 255, 255];

/**
 * The nearest tone of `hex` that reads as text on `surface`, found by moving
 * HSV value toward or away from the surface and only then desaturating.
 *
 * A colour a person picked for an upstream is an identity, not a foreground:
 * it is chosen against whichever scheme that person happened to be in, and the
 * same literal then has to label a chip on a near-white card and on a near-black
 * one. Hue is what carries the identity, so hue is what this holds fixed; value
 * moves first because it costs the least recognition, and saturation gives way
 * only where value alone cannot get there.
 *
 * Which hues those are depends on the direction. Darkening always works — every
 * hue reaches black — so on a light surface value alone suffices, a saturated
 * yellow included. Brightening does not: a fully saturated blue reads 1.24:1 on
 * its own chip over a washed dark card at full value, and cannot be made lighter
 * without losing saturation, because its channels are already at their limit.
 */
export const readableTone = (hex: string, surface: string): string => {
  const rgb = hexToRgb(hex);
  const surfaceRgb = hexToRgb(surface);
  if (!rgb || !surfaceRgb) return hex;
  if (contrastRatio(rgb, surfaceRgb) >= TEXT_CONTRAST_FLOOR) return hex;

  const [h, s, v] = rgbToHsv(...rgb);
  // Which way to move is decided by which extreme actually clears the floor,
  // not by whether the surface is light. A mid surface can be too dark for
  // black and too light for white; between luminance 0.183 and 0.5 white misses
  // the floor while black clears it, so a lightness test would search the one
  // direction that cannot arrive.
  const darken = contrastRatio(BLACK, surfaceRgb) > contrastRatio(WHITE, surfaceRgb);
  const STEPS = 100;

  for (let saturation = s; saturation >= 0; saturation -= 0.1) {
    for (let step = 1; step <= STEPS; step += 1) {
      const value = darken ? v * (1 - step / STEPS) : v + (1 - v) * (step / STEPS);
      const candidate = hsvToRgb(h, saturation, value);
      if (contrastRatio(candidate, surfaceRgb) >= TEXT_CONTRAST_FLOOR) return rgbToHex(...candidate);
    }
  }
  // The saturation ladder steps by a tenth, so unless the colour's own
  // saturation is a multiple of a tenth the last rung stops short of zero and
  // still carries a trace of hue. That trace only costs anything on a mid
  // surface, where the extreme that wins is itself barely over the floor and
  // the rung misses. The extreme is the answer there, and it always clears: the
  // two ratios a surface gives black and white multiply to exactly 21, so the
  // larger of them is never below sqrt(21), or about 4.58. No surface exists
  // that neither extreme reads on.
  return rgbToHex(...(darken ? BLACK : WHITE));
};

/** Whether an upstream's colour is a literal rather than one of the named tones. */
export const isHexColor = (color: UpstreamColor | null): color is `#${string}` => color?.startsWith('#') === true;

// The surface a badge's own fill composites over, which is what its label has
// to read against. A badge sits on a card, in a dialog, and inside table and
// list rows, so that surface is a range rather than one colour: a row washes
// itself with WinUI's subtle pointer fills, and the request list marks its
// selected row with Fluent's brand tint. The label is one literal per scheme,
// so it is resolved against the end of the range that is hardest for it -- the
// darkest surface in light, the lightest in dark -- and every other state then
// reads with more contrast than the floor rather than less.
//
// In light the label is dark, and the darkest surface under it is the selected
// request row: Fluent's brand 160, #EBF3FC. Next darkest is a white card washed
// by SubtleFillColorSecondary -- #00000009 over white, or #F6F6F6 -- which is
// lighter than that.
//
// In dark the label is light, and the lightest surface under it is a washed
// card: CardBackgroundFillColorDefault #ffffff0d over
// SolidBackgroundFillColorQuarternary #2c2c2c composites to #373737, and
// SubtleFillColorSecondary #ffffff0f over that gives #434343. The dialog body
// (#2B2B2B) and the selected request row (Fluent's brand 20, #082338) both sit
// below it.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L26
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L56
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L71
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L230
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/tokens/src/global/brandColors.ts#L5-L19
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/tokens/src/alias/lightColor.ts#L138
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/tokens/src/alias/darkColor.ts#L132
const HARDEST_BADGE_SURFACE = { light: '#EBF3FC', dark: '#434343' } as const;
const BADGE_FILL_ALPHA = 0.1;
const BADGE_STROKE_ALPHA = 0.35;

/**
 * A badge painted in an arbitrary hue: the hue at a tenth for the fill, at a
 * third for the stroke, and a label resolved against the fill rather than the
 * surface under it, because the wash moves the reading by enough to change the
 * answer.
 *
 * The fill and stroke need no light-dark pair -- they are fractions of the hue
 * and composite over whichever surface is beneath, so they follow the pointer
 * and selection states of that surface on their own. The label does: one
 * literal would be picked against one scheme and used in both, and one per
 * scheme cannot follow those states, which is why each is resolved against the
 * surface hardest for it. A forced palette repaints all three, so none of this
 * survives into high contrast, and none of it needs to.
 */
export const badgeHueStyle = (hue: string): Record<string, string> => {
  const label = (surface: string) => readableTone(hue, blendHex(hue, BADGE_FILL_ALPHA, surface));
  return {
    '--floway-badge-hue': hue,
    backgroundColor: `color-mix(in srgb, var(--floway-badge-hue) ${BADGE_FILL_ALPHA * 100}%, transparent)`,
    borderColor: `color-mix(in srgb, var(--floway-badge-hue) ${BADGE_STROKE_ALPHA * 100}%, transparent)`,
    color: `light-dark(${label(HARDEST_BADGE_SURFACE.light)}, ${label(HARDEST_BADGE_SURFACE.dark)})`,
  };
};
