import { readFile } from 'node:fs/promises';

import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

import { fontsourceWoff2Only } from '../postcss.config';

const fontsourcePath = '/workspace/node_modules/@fontsource/example/400.css';

const process = async (css: string, from = fontsourcePath): Promise<string> =>
  (await postcss([fontsourceWoff2Only()]).process(css, { from })).css;

describe('Fontsource WOFF2-only transform', () => {
  it('removes WOFF list items while preserving every other source', async () => {
    const css = `@font-face {
      SRC: local("Example"),
        URL( './example.WOFF' ) FORMAT( "WOFF" ),
        url('./example.woff2') format('woff2'),
        url('./example-bold.woff') format('woff'),
        local('Example fallback');
    }`;

    const output = await process(css);

    expect(output).toContain('local("Example")');
    expect(output).toContain("url('./example.woff2') format('woff2')");
    expect(output).toContain("local('Example fallback')");
    expect(output).not.toMatch(/example(?:-bold)?\.woff(?:['")?#]|$)/i);
    expect(postcss.parse(output).nodes).toHaveLength(1);
  });

  it('understands escaped URL and format values', async () => {
    const css = String.raw`@font-face {
      src: url('./example.wo\66 f2') format('\77 off2'),
        url('./example.wo\66 f') format('\77 off');
    }`;

    const output = await process(css);

    expect(output).toContain(String.raw`url('./example.wo\66 f2') format('\77 off2')`);
    expect(output).not.toContain(String.raw`example.wo\66 f')`);
  });

  it('recognizes escaped src descriptors', async () => {
    const css = String.raw`@font-face {
      s\72 c: url('./example.woff2') format('woff2'),
        url('./example.woff') format('woff');
    }`;

    const output = await process(css);

    expect(output).toContain(String.raw`s\72 c: url('./example.woff2') format('woff2')`);
    expect(output).not.toContain("url('./example.woff')");
  });

  it('classifies URL pathnames independently of query strings and fragments', async () => {
    const css = `@font-face {
      src: url('./example.woff2?fallback=.woff') format('woff2'),
        url('./example-alt.woff2#fallback=.woff') format('woff2'),
        url('./example.woff?cache=1'),
        url('./example-alt.woff#cache');
    }`;

    const output = await process(css);

    expect(output).toContain("url('./example.woff2?fallback=.woff') format('woff2')");
    expect(output).toContain("url('./example-alt.woff2#fallback=.woff') format('woff2')");
    expect(output).not.toContain("url('./example.woff?cache=1')");
    expect(output).not.toContain("url('./example-alt.woff#cache')");
  });

  it('treats data URL commas as URL content', async () => {
    const css = `@font-face {
      src: url('data:font/woff2;base64,d09GMg==') format('woff2'),
        url('data:font/woff;base64,d09GRg==') format('woff');
    }`;

    const output = await process(css);

    expect(output).toContain("url('data:font/woff2;base64,d09GMg==') format('woff2')");
    expect(output).not.toContain('d09GRg==');
  });

  it('rejects malformed upstream source values', async () => {
    await expect(process(`@font-face { src: url('./example.woff2') format('woff2'),; }`))
      .rejects.toThrow('contains an empty font source');
    await expect(process(`@font-face { src: url('./example.woff') format('woff' }`))
      .rejects.toThrow('Unclosed bracket');
    await expect(process(`@font-face { src: url('./example.woff') format('woff'); }`))
      .rejects.toThrow('does not declare a non-WOFF font source');
  });

  it('does not transform non-Fontsource stylesheets', async () => {
    const css = `@font-face { src: url('./example.woff') format('woff'); }`;

    expect(await process(css, '/workspace/src/global.css')).toBe(css);
  });

  it.each(['?inline', '#transform-only'])('matches Fontsource IDs carrying %s', async suffix => {
    const css = `@font-face {
      src: url('./example.woff2') format('woff2'), url('./example.woff') format('woff');
    }`;

    expect(await process(css, `${fontsourcePath}${suffix}`)).not.toContain("format('woff')");
  });

  it('fails if WOFF remains anywhere in a Fontsource stylesheet', async () => {
    const css = `:root { --unexpected-font: url('./example.woff') format('woff'); }`;

    await expect(process(css)).rejects.toThrow('still declares a WOFF source');
  });

  it('does not interpret format functions outside src descriptors as font sources', async () => {
    const css = `:root { --font-format-label: format('woff'); }`;

    expect(await process(css)).toBe(css);
  });

  it.each(['400.css', '600.css', '700.css'])('processes the installed Maple Mono %s stylesheet', async file => {
    const path = import.meta.resolve(`@fontsource/maple-mono/${file}`);
    const css = await readFile(new URL(path), 'utf8');
    const output = await process(css, new URL(path).pathname);

    expect(output).toContain("format('woff2')");
    expect(output).not.toContain("format('woff')");
    expect(output).not.toMatch(/\.woff(?:['")?#]|$)/i);
  });
});
