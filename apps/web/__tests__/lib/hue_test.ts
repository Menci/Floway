import { converter } from 'culori/fn';
import { describe, expect, it } from 'vitest';

import { hueBadgeTone, HUE_RAIL_GRADIENT, pickDistinctHue } from '../../src/lib/hue';

const toOklch = converter('oklch');

const everyHue = Array.from({ length: 360 }, (_, hue) => hue);

// The ladder @proj-airi/chromatic states, restated here so a change to the
// subject's constants has to be a deliberate edit on both sides rather than a
// test that follows it.
// https://github.com/proj-airi/chromatic/blob/6834a75c3a7a1944bbb7377df7811a1f92f1b303/packages/chromatic/src/index.ts#L45-L57
// https://github.com/proj-airi/chromatic/blob/6834a75c3a7a1944bbb7377df7811a1f92f1b303/packages/chromatic/src/index.ts#L92-L94
const expected = (scheme: 'light' | 'dark', hue: number) => {
  const { lightness, multiplier } = scheme === 'light'
    ? { lightness: 0.54, multiplier: 1.15 }
    : { lightness: 0.85, multiplier: 0.75 };
  return { lightness, chroma: (0.18 + Math.cos((hue * Math.PI) / 180) * 0.04) * multiplier };
};

describe('hueBadgeTone', () => {
  it.each([
    [0, '#d30069', '#ff9cc9'],
    [30, '#da0000', '#ffa28d'],
    [60, '#c63400', '#ffb45f'],
    [90, '#9d6200', '#f0c95b'],
    [120, '#637b00', '#c4da7d'],
    [150, '#008833', '#99e2a8'],
    [180, '#008a72', '#78e4d0'],
    [210, '#0085a3', '#6ce1f5'],
    [240, '#0076cd', '#80d8ff'],
    [270, '#435ce4', '#abc9ff'],
    [300, '#873bdd', '#ddb6ff'],
    [330, '#b600b0', '#ffa5ff'],
    [359, '#d3006b', '#ff9ccb'],
  ])('preserves the frozen badge tones at %s degrees', (hue, light, dark) => {
    expect(hueBadgeTone(hue)).toEqual({ light, dark });
  });

  it('paints the shade the chromatic ladder states for the hue', () => {
    for (const hue of everyHue) {
      const tone = hueBadgeTone(hue);
      for (const scheme of ['light', 'dark'] as const) {
        const want = expected(scheme, hue);
        const read = toOklch(scheme === 'light' ? tone.light : tone.dark)!;
        // A hue sRGB cannot hold comes back with its channels clamped, which
        // moves the lightness a little either way and can only take chroma. The
        // lightness stays close enough that the two rungs never approach each
        // other, which is what would make a light badge and a dark one the same
        // colour.
        expect(Math.abs(read.l - want.lightness), `${scheme} ${hue}deg`).toBeLessThan(0.06);
        expect(read.c, `${scheme} ${hue}deg`).toBeLessThanOrEqual(want.chroma + 0.005);
      }
    }
  });

  it('carries far more chroma than a flat pale ramp would', () => {
    // The whole reason for the hue-dependent curve: a badge that reads as a
    // colour rather than as a grey with a tint.
    const chroma = everyHue.map(hue => toOklch(hueBadgeTone(hue).light)!.c);
    expect(Math.min(...chroma)).toBeGreaterThan(0.09);
  });

  it('separates neighbouring hues', () => {
    // Two upstreams a rail step apart have to be told apart at a glance, which
    // a clamp flattening a stretch of the circle onto one colour would break.
    const distinct = new Set(everyHue.map(hue => hueBadgeTone(hue).light));
    expect(distinct.size).toBeGreaterThan(300);
  });
});

describe('HUE_RAIL_GRADIENT', () => {
  it('names one colour per degree', () => {
    const stops = HUE_RAIL_GRADIENT.match(/#[0-9a-f]{6}/g) ?? [];
    // A gradient interpolates between its stops in sRGB, so a coarser ramp
    // would cut the corner between two hues.
    expect(stops).toHaveLength(361);
    expect(stops[0]).toBe(stops[360]);
  });
});

describe('pickDistinctHue', () => {
  it('halves the circle against a single upstream', () => {
    expect(pickDistinctHue([90])).toBe(270);
    expect(pickDistinctHue([300])).toBe(120);
  });

  it('takes the middle of the widest gap', () => {
    expect(pickDistinctHue([0, 10, 20])).toBe(190);
    expect(pickDistinctHue([0, 200, 210])).toBe(100);
  });

  it('measures the gap that wraps past 0 like any other', () => {
    expect(pickDistinctHue([170, 190])).toBe(0);
  });

  it('ignores a hue two upstreams share', () => {
    expect(pickDistinctHue([90, 90, 90])).toBe(270);
  });

  it('answers within the circle for an empty console', () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const hue = pickDistinctHue([]);
      expect(Number.isInteger(hue) && hue >= 0 && hue < 360).toBe(true);
    }
  });

  it('stays within the circle whichever tie it breaks', () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      expect([90, 270]).toContain(pickDistinctHue([0, 180]));
    }
  });
});
