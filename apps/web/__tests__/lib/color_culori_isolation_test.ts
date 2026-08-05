import { getMode } from 'culori/fn';
import { describe, expect, it } from 'vitest';

import { hexToRgb, readableTone } from '../../src/lib/color';

describe('color Culori registry isolation', () => {
  it('uses direct operations without registering unrelated color modes', () => {
    expect(hexToRgb('#4CC2FF')).toEqual([76, 194, 255]);
    expect(readableTone('#00E5FF', '#FFFFFF')).toBe('#008391');
    expect(getMode('rgb')).toBeUndefined();
    expect(getMode('hsv')).toBeUndefined();
    expect(getMode('lrgb')).toBeUndefined();
    expect(getMode('oklch')).toBeUndefined();
  });
});
