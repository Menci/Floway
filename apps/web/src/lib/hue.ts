import { converter, formatHex, modeOklch, modeRgb, useMode as registerMode } from 'culori/fn';

import type { BadgeHue } from './color';

// culori's tree-shakeable entry only knows the color spaces that were
// registered, and `converter` resolves its path through that registry.
registerMode(modeRgb);
const toRgb = converter('rgb');
registerMode(modeOklch);

// A badge hue is stated once per scheme at a fixed lightness and chroma, so
// every hue reads with the same weight -- the whole point of choosing OKLCH
// over HSV, where a yellow at the chroma of a blue is far lighter than it.
//
// The chroma of each pair is the lowest a hue can reach at that lightness
// anywhere on the circle (0.085 at h~200 for L=0.50, 0.100 at h~267 for
// L=0.80), so nothing is ever out of the sRGB gamut and no hue is bent by a
// gamut mapping or a channel clip on its way to a hex. Both also sit inside the
// range the hand-picked provider tones occupied before the hue replaced them,
// so no badge changed weight when it did.
const BADGE_LIGHTNESS = { light: 0.5, dark: 0.8 } as const;
const BADGE_CHROMA = { light: 0.085, dark: 0.1 } as const;

const toneHex = (scheme: 'light' | 'dark', hue: number): string =>
  formatHex(toRgb({ mode: 'oklch', l: BADGE_LIGHTNESS[scheme], c: BADGE_CHROMA[scheme], h: hue }));

/** The light/dark pair `badgeHueStyle` paints an upstream's hue with. */
export const hueBadgeTone = (hue: number): Extract<BadgeHue, { light: string }> => ({
  light: toneHex('light', hue),
  dark: toneHex('dark', hue),
});

// The ramp the hue rail is painted with: the tone each hue would give a badge,
// so the rail shows what is being chosen rather than a raw HSV spectrum. Twelve
// steps put a stop every 30°, which is close enough that the interpolation
// between two of them never crosses a hue the rail does not name.
export const HUE_RAMP_GRADIENT = `linear-gradient(to right, ${
  Array.from({ length: 13 }, (_, step) => {
    const tone = hueBadgeTone((step * 360) / 12);
    return `light-dark(${tone.light}, ${tone.dark})`;
  }).join(', ')
})`;

/**
 * A hue for a new upstream: the middle of the widest arc left unclaimed by the
 * hues already in use, so the badge is as far from every existing one as the
 * circle allows. Ties are broken at random, and an empty console draws a
 * uniformly random hue rather than always starting at the same place.
 */
export const pickDistinctHue = (existing: readonly number[]): number => {
  const claimed = [...new Set(existing)].sort((a, b) => a - b);
  if (claimed.length === 0) return Math.floor(Math.random() * 360);
  // Each hue's gap runs to the next one, and the last wraps to the first.
  const gaps = claimed.map((hue, index) => ({
    hue,
    width: index === claimed.length - 1 ? claimed[0]! + 360 - hue : claimed[index + 1]! - hue,
  }));
  const widest = Math.max(...gaps.map(gap => gap.width));
  const candidates = gaps.filter(gap => gap.width === widest);
  const chosen = candidates[Math.floor(Math.random() * candidates.length)]!;
  return Math.round(chosen.hue + chosen.width / 2) % 360;
};
