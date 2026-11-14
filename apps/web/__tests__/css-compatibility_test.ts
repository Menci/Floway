import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

import { assertLegacyCss, legacyCssPostCssPlugins } from '../css-compatibility';

describe('browser CSS compatibility', () => {
  it.each([
    '#0000',
    '#11223344',
    'rgb(255 0 0)',
    'rgb(from red r g b)',
    'hsl(120 50% 50% / 50%)',
    'hwb(120 30% 50%)',
    'lab(50% 40 30)',
    'lch(50% 40 30)',
    'oklab(50% 0.1 0.1)',
    'oklch(50% 0.1 30)',
    'color(display-p3 1 0 0)',
  ])('rejects %s', async syntax => {
    await expect(assertLegacyCss('fixture.css', `.fixture { color: ${syntax}; }`))
      .rejects.toThrow('Unsupported CSS reached the browser boundary');
  });

  it.each([
    '#000000',
    '#112233',
    'rgb(255, 0, 0)',
    'rgba(255, 0, 0, 0.5)',
    'hsl(120, 50%, 50%)',
    'hsla(120, 50%, 50%, 0.5)',
  ])('accepts %s', async syntax => {
    await expect(assertLegacyCss('fixture.css', `.fixture { color: ${syntax}; }`)).resolves.toBeUndefined();
  });

  it('lowers supported modern notation before the browser boundary', async () => {
    const modern = '.fixture { color: #11223344; background: rgb(1 2 3 / 50%); border-color: hsl(120 50% 25% / 40%); }';
    const result = await postcss(legacyCssPostCssPlugins()).process(modern, { from: undefined });

    expect(result.css).toContain('rgba(17,34,51,0.26667)');
    expect(result.css).toContain('rgba(1, 2, 3, 0.5)');
    expect(result.css).toContain('hsla(120, 50%, 25%, 0.4)');
    await expect(assertLegacyCss('fixture.css', result.css)).resolves.toBeUndefined();
  });
});
