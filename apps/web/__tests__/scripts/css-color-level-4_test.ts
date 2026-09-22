import { describe, expect, it } from 'vitest';

import { findCssColorLevel4 } from '../../scripts/css-color-level-4';

describe('CSS Color Level 4 browser boundary', () => {
  it.each([
    '#0000',
    '#11223344',
    'hwb(120 30% 50%)',
    'lab(50% 40 30)',
    'lch(50% 40 30)',
    'oklab(50% 0.1 0.1)',
    'oklch(50% 0.1 30)',
    'color(display-p3 1 0 0)',
    'rgb(255 0 0)',
    'rgb(from red r g b)',
    'hsl(120 50% 50% / 50%)',
  ])('rejects %s', syntax => {
    expect(findCssColorLevel4(`color: ${syntax};`)).toEqual([
      expect.objectContaining({ syntax }),
    ]);
  });

  it.each([
    '#000000',
    '#112233',
    'rgb(255, 0, 0)',
    'rgba(255, 0, 0, 0.5)',
    'hsl(120, 50%, 50%)',
    'hsla(120, 50%, 50%, 0.5)',
    "{ mode: 'oklch', l: 0.7, c: 0.13, h: hue }",
  ])('accepts %s', syntax => {
    expect(findCssColorLevel4(`color: ${syntax};`)).toEqual([]);
  });
});
