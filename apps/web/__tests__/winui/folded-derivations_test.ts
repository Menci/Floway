import { describe, expect, it } from 'vitest';

import { blendHex, hexToRgb } from '../../src/lib/color';
import { listCss } from '../../src/winui/controls/list.css';
import { winuiTokenCss } from '../../src/winui/tokens';

// These are folded constants with the recipe stated beside them, which leaves
// the recipe unchecked: retuning an accent step or a surface would repaint
// every accent fill while the wash beside it kept the old blue. Each value is
// checked against its recipe here.
//
// The sheet carries many `:root` blocks, one per token group, and restates the
// ones a scheme overrides inside a dark media query. Each scheme is therefore
// every block that applies to it, merged in source order the way the cascade
// merges them.
const declarationsByScheme = (css: string) => {
  const dark = [...css.matchAll(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([^}]*)\}/g)];
  const every = [...css.matchAll(/:root\s*\{([^}]*)\}/g)];
  const darkBodies = new Set(dark.map(([, body]) => body));
  const merge = (bodies: string[]) => new Map(bodies.flatMap(body =>
    [...body.matchAll(/(--winui-[a-z0-9-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()] as const)));
  const light = merge(every.map(([, body]) => body).filter(body => !darkBodies.has(body)));
  return [light, new Map([...light, ...merge([...darkBodies])])];
};

// A token stated as `var(--other)` is followed to the literal it names.
const resolve = (declared: Map<string, string>, name: string): string => {
  const value = declared.get(name);
  if (value === undefined) throw new Error(`${name} is declared in no :root body`);
  const indirect = /^var\((--winui-[a-z0-9-]+)\)$/.exec(value);
  return indirect ? resolve(declared, indirect[1]!) : value;
};

// The weights the comment beside the tints states, light then dark.
const TINT_WEIGHTS = [
  { fill: 'default', light: 0.08, dark: 0.14 },
  { fill: 'secondary', light: 0.12, dark: 0.21 },
  { fill: 'tertiary', light: 0.16, dark: 0.28 },
  { fill: 'stroke', light: 0.30, dark: 0.525 },
] as const;

describe('folded winui derivations', () => {
  it('keeps every accent tint the wash its recipe states', () => {
    const schemes = declarationsByScheme(winuiTokenCss);
    const stale: string[] = [];
    for (const [index, scheme] of (['light', 'dark'] as const).entries()) {
      const accent = resolve(schemes[index]!, '--winui-accent-base');
      const surface = resolve(schemes[index]!, '--winui-solid-background-fill-quarternary');
      for (const weight of TINT_WEIGHTS) {
        const name = weight.fill === 'stroke' ? '--winui-accent-tint-stroke' : `--winui-accent-tint-fill-${weight.fill}`;
        const declared = schemes[index]!.get(name);
        const expected = blendHex(accent, weight[scheme], surface).toLowerCase();
        if (declared !== expected) stale.push(`${scheme} ${name} is ${declared}, but ${accent} at ${Number((weight[scheme] * 100).toFixed(3))}% over ${surface} is ${expected}`);
      }
    }
    expect(stale).toEqual([]);
  });

  it('keeps the disabled row the share of the text fill its recipe states', () => {
    const schemes = declarationsByScheme(winuiTokenCss);
    // The rule appears once at the top level and once under the dark query, in
    // that order, and the source already carries an alpha of its own.
    const declared = [...listCss.matchAll(/\[aria-disabled='true'\]\s*\{[^}]*?color:\s*(#[0-9a-f]{8})/g)].map(([, hex]) => hex);
    expect(declared).toHaveLength(2);

    const stale: string[] = [];
    for (const [index, scheme] of (['light', 'dark'] as const).entries()) {
      const source = resolve(schemes[index]!, '--winui-text-fill-primary');
      const sourceAlpha = source.length === 9 ? parseInt(source.slice(7, 9), 16) / 255 : 1;
      const expected = `${source.slice(0, 7)}${Math.round(sourceAlpha * 0.3 * 255).toString(16).padStart(2, '0')}`;
      if (declared[index] !== expected) stale.push(`${scheme} disabled row is ${declared[index]}, but 30% of ${source} is ${expected}`);
    }
    expect(stale).toEqual([]);
  });

  it('reads a channel companion as the channels of its own hex', () => {
    // Guards the two helpers above: a resolve() that silently returned the
    // light value for both schemes would make either check vacuous.
    const schemes = declarationsByScheme(winuiTokenCss);
    expect(resolve(schemes[0]!, '--winui-accent-base')).not.toBe(resolve(schemes[1]!, '--winui-accent-base'));
    expect(hexToRgb(resolve(schemes[0]!, '--winui-accent-base'))).toEqual([0, 103, 192]);
  });
});
