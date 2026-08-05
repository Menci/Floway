import { getMode } from 'culori/fn';
import { describe, expect, it } from 'vitest';

import { hsvToRgb } from '../../src/lib/color';

describe('color Culori registry isolation', () => {
  it('uses direct operations without registering unrelated color modes', () => {
    expect(hsvToRgb(210, 1, 1)).toEqual([0, 128, 255]);
    expect(getMode('rgb')).toBeUndefined();
    expect(getMode('hsv')).toBeUndefined();
    expect(getMode('lrgb')).toBeUndefined();
    expect(getMode('oklch')).toBeUndefined();
  });
});
