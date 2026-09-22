import { describe, expect, it } from 'vitest';

import { toLegacyCssColor } from '../../src/lib/legacy-css-color';

describe('legacy CSS color serialization', () => {
  it.each([
    ['#0000', 'rgba(0, 0, 0, 0)'],
    ['#11223344', 'rgba(17, 34, 51, 0.266667)'],
    ['rgb(1 2 3)', 'rgb(1, 2, 3)'],
    ['rgb(1 2 3 / 50%)', 'rgba(1, 2, 3, 0.5)'],
    ['hsl(120 50% 25% / .4)', 'hsla(120, 50%, 25%, .4)'],
  ])('converts %s', (source, expected) => {
    expect(toLegacyCssColor(source)).toBe(expected);
  });

  it('leaves legacy and non-color text untouched', () => {
    const source = 'rgba(1, 2, 3, .5) var(--surface) #123456';
    expect(toLegacyCssColor(source)).toBe(source);
  });
});
