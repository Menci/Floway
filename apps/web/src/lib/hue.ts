import { converter, formatHex, modeOklch, modeRgb, useMode as registerMode } from 'culori/fn';

registerMode(modeRgb);
registerMode(modeOklch);
const toRgb = converter('rgb');

// How much chroma a hue can carry before it reads heavier than its neighbours.
// Red takes the most and cyan the least, which is why a flat chroma leaves half
// the circle looking washed out. Taken from @proj-airi/chromatic, whose ladder
// below comes with it.
// https://github.com/proj-airi/chromatic/blob/6834a75c3a7a1944bbb7377df7811a1f92f1b303/packages/chromatic/src/index.ts#L92-L94
const baseChromaByHue = (hue: number): number => 0.18 + Math.cos((hue * Math.PI) / 180) * 0.04;

// Two rungs of that ladder. Neither the ladder nor this badge has a light and a
// dark formula: a scheme picks a different rung of the one ladder, the way
// every consumer of the ladder does.
// https://github.com/proj-airi/chromatic/blob/6834a75c3a7a1944bbb7377df7811a1f92f1b303/packages/chromatic/src/index.ts#L45-L57
const BADGE_SHADE = {
  light: { lightness: 0.54, chromaMultiplier: 1.15 },
  dark: { lightness: 0.85, chromaMultiplier: 0.75 },
} as const;

// The ladder asks for more chroma than sRGB can hold across most of the circle,
// and out-of-gamut channels are clamped rather than gamut-mapped, which is what
// a browser handed the same `oklch()` would paint. A hue that clamps shifts a
// little; a hue that is mapped instead loses the chroma the ladder exists to
// give it.
const shadeHex = (scheme: keyof typeof BADGE_SHADE, hue: number): string => {
  const { lightness, chromaMultiplier } = BADGE_SHADE[scheme];
  return formatHex(toRgb({ mode: 'oklch', l: lightness, c: baseChromaByHue(hue) * chromaMultiplier, h: hue }));
};

/** The light/dark pair `useBadgeHue` paints an upstream's hue with. */
export const hueBadgeTone = (hue: number): { light: string; dark: string } => ({
  light: shadeHex('light', hue),
  dark: shadeHex('dark', hue),
});

// The rail is deliberately not the badge's own curve: it is one flat, brighter
// ribbon that reads the same in both schemes, so the control shows the hue
// being chosen rather than the weight it will be painted at. Same values AIRI's
// hue range uses.
// https://github.com/moeru-ai/airi/blob/faf96ef3374fab831fc323acce74fee219eab184/packages/ui/src/components/form/range/color-hue-range.vue
const RAIL_LIGHTNESS = 0.85;
const RAIL_CHROMA = 0.2;

// One stop per degree, resolved here rather than left to the browser: a
// gradient interpolates between its stops in sRGB, so a coarser ramp would cut
// the corner between two hues and pass through colours the circle does not
// contain.
export const HUE_RAIL_GRADIENT = `linear-gradient(to right, ${
  Array.from({ length: 361 }, (_, hue) =>
    formatHex(toRgb({ mode: 'oklch', l: RAIL_LIGHTNESS, c: RAIL_CHROMA, h: hue % 360 }))).join(', ')
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
