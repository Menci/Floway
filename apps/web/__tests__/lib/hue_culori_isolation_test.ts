import { converter } from 'culori/fn';
import { describe, expect, it } from 'vitest';

import { hueBadgeTone } from '../../src/lib/hue';

describe('hue Culori registry isolation', () => {
  it('makes the color-utility conversion path available from the hue entry point', () => {
    expect(hueBadgeTone(210)).toEqual({ light: expect.stringMatching(/^#[0-9a-f]{6}$/), dark: expect.any(String) });
    expect(converter('hsv')({ mode: 'rgb', r: 0, g: 0.5, b: 1 })).toMatchObject({ mode: 'hsv' });
  });
});
