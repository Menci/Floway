import { converter } from 'culori/fn';
import { describe, expect, it } from 'vitest';

import { hsvToRgb } from '../../src/lib/color';

describe('color Culori registry isolation', () => {
  it('makes the hue-rendering conversion path available from the color entry point', () => {
    expect(hsvToRgb(210, 1, 1)).toEqual([0, 128, 255]);
    expect(converter('oklch')({ mode: 'rgb', r: 0, g: 0.5, b: 1 })).toMatchObject({ mode: 'oklch' });
  });
});
