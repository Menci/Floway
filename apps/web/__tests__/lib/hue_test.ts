import { converter, modeOklch, modeRgb, useMode as registerMode } from 'culori/fn';
import { describe, expect, it } from 'vitest';

import { hueBadgeTone, pickDistinctHue } from '../../src/lib/hue';

registerMode(modeRgb);
registerMode(modeOklch);
const toOklch = converter('oklch');

const everyHue = Array.from({ length: 360 }, (_, hue) => hue);

describe('hueBadgeTone', () => {
  it('holds the hue it was asked for, in both schemes', () => {
    for (const hue of everyHue) {
      const tone = hueBadgeTone(hue);
      for (const hex of [tone.light, tone.dark]) {
        const read = toOklch(hex)!.h!;
        const delta = Math.abs(read - hue);
        // A tone bent to fit the gamut would come back on another angle. The
        // tolerance is the 8-bit hex step, which at this chroma is worth about
        // a degree of arc; a gamut mapping would cost tens.
        expect(Math.min(delta, 360 - delta), `${hue}° rendered ${hex}`).toBeLessThan(1.5);
      }
    }
  });

  // A hue that fell outside the sRGB gamut would come back either bent, which
  // the hue assertion above catches, or muted, which this one does: a gamut
  // mapping and a channel clip both cost chroma, and the whole point of the
  // chosen pair is that neither ever has to happen.
  it('gives every hue the same lightness and chroma within its scheme', () => {
    const readings = (pick: (tone: ReturnType<typeof hueBadgeTone>) => string) =>
      everyHue.map(hue => toOklch(pick(hueBadgeTone(hue)))!);
    for (const scheme of [readings(tone => tone.light), readings(tone => tone.dark)]) {
      const lightness = scheme.map(reading => reading.l);
      const chroma = scheme.map(reading => reading.c);
      expect(Math.max(...lightness) - Math.min(...lightness)).toBeLessThan(0.01);
      expect(Math.max(...chroma) - Math.min(...chroma)).toBeLessThan(0.005);
    }
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
