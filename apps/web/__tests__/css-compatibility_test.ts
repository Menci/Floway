import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

import { assertLegacyCss, legacyCssPostCssPlugins } from '../css-compatibility';

describe('browser CSS compatibility', () => {
  it('rejects modern notation and accepts legacy notation', async () => {
    await expect(assertLegacyCss('fixture.css', '.fixture { color: #11223344; }'))
      .rejects.toThrow('Unsupported CSS reached the browser boundary');
    await expect(assertLegacyCss('fixture.css', '.fixture { color: #112233; }')).resolves.toBeUndefined();
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
