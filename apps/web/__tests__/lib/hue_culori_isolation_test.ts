import { getMode } from 'culori/fn';
import { describe, expect, it } from 'vitest';

import { hueBadgeTone } from '../../src/lib/hue';

describe('hue Culori registry isolation', () => {
  it('registers only the modes its rendering owns', () => {
    expect(hueBadgeTone(210)).toEqual({ light: expect.stringMatching(/^#[0-9a-f]{6}$/), dark: expect.any(String) });
    expect(getMode('rgb')).toBeDefined();
    expect(getMode('oklch')).toBeDefined();
    expect(getMode('hsv')).toBeUndefined();
    expect(getMode('lrgb')).toBeUndefined();
  });
});
