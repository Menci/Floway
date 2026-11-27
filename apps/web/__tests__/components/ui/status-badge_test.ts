import { describe, expect, it } from 'vitest';

import { pickIdentityHue } from '../../../src/components/ui/status-badge';
import { hexHue } from '../../../src/lib/hue';

// The critical fill ../../../src/winui/tokens.ts states for each scheme,
// restated so the test does not follow the subject.
const critical = ['#c42b1c', '#ff99a4'].map(hexHue);
const distance = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
const clearance = (hue: number) => Math.min(...critical.map(red => distance(hue, red)));

describe('pickIdentityHue', () => {
  it('keeps a second badge off the critical red the first one faces', () => {
    // Opposite a cyan first badge, the circle alone would hand the second the
    // critical red.
    const hue = pickIdentityHue([195]);
    expect(clearance(hue)).toBeGreaterThan(60);
  });

  it('starts an empty console well clear of the critical red', () => {
    for (let draw = 0; draw < 200; draw += 1) {
      expect(clearance(pickIdentityHue([]))).toBeGreaterThanOrEqual(85);
    }
  });
});
