import { converter } from 'culori/fn';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { hexHue, hueBadgeTone, pickDistinctHue } from '../../src/lib/hue';

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
});

describe('pickDistinctHue', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('takes the middle of the widest gap', () => {
    expect(pickDistinctHue([0, 10, 20], [])).toBe(190);
    expect(pickDistinctHue([0, 200, 210], [])).toBe(100);
  });

  it('measures the gap that wraps past 0 like any other', () => {
    expect(pickDistinctHue([170, 190], [])).toBe(0);
  });

  it('keeps as clear of a hue to avoid as of one in use', () => {
    // Without the hue to avoid, the widest gap is the one opposite 200.
    expect(pickDistinctHue([200], [])).toBe(20);
    expect(pickDistinctHue([200], [30])).toBe(295);
  });

  it('draws an empty console from the whole circle', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    expect(pickDistinctHue([], [])).toBe(180);
  });

  it('draws an empty console from the middle half of the arc the hues to avoid leave', () => {
    const random = vi.spyOn(Math, 'random');
    random.mockReturnValue(0);
    expect(pickDistinctHue([], [10, 30])).toBe(115);
    random.mockReturnValue(1 - Number.EPSILON);
    expect(pickDistinctHue([], [10, 30])).toBe(285);
  });
});

describe('hexHue', () => {
  it('reads the OKLCH hue', () => {
    expect(hexHue('#c42b1c')).toBeCloseTo(30.1, 1);
  });

  it('refuses a colour without one', () => {
    expect(() => hexHue('#808080')).toThrow(TypeError);
  });
});
