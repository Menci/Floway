import { parseHex } from 'culori/fn';
import { describe, expect, it } from 'vitest';

import { blendHex } from '../../src/lib/color';
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

// The tints are folded with their recipe in a comment beside them, which makes
// that comment the only account a reader gets. Reading the weights out of it
// rather than restating them here is what stops the two drifting apart: a
// reworded or retuned recipe then fails instead of quietly becoming a lie.
const TINT_NAMES = [
  '--winui-accent-tint-fill-default',
  '--winui-accent-tint-fill-secondary',
  '--winui-accent-tint-fill-tertiary',
  '--winui-accent-tint-stroke',
] as const;

// Read to the end of the comment rather than to the first full stop: a weight
// of 52.5% carries one of its own.
const statedTintWeights = (css: string) =>
  [...css.matchAll(/--winui-accent-base over --winui-solid-background-fill-quarternary at([\s\S]*?)\*\//g)]
    .map(([, list]) => [...list.matchAll(/([\d.]+)%/g)].map(([, percent]) => Number(percent) / 100));

const statedShare = (css: string, of: string) => {
  const stated = [...css.matchAll(new RegExp(`([\\d.]+)% of ${of}`, 'g'))].map(([, percent]) => Number(percent) / 100);
  return stated;
};

const rgbBytes = (hex: string) => {
  const { r, g, b } = parseHex(hex)!;
  return [r, g, b].map(channel => Math.round(channel * 255));
};

describe('folded winui derivations', () => {
  it('keeps every accent tint the wash its recipe states', () => {
    const schemes = declarationsByScheme(winuiTokenCss);
    const weights = statedTintWeights(winuiTokenCss);
    // One recipe per scheme, each naming a weight per tint.
    expect(weights).toHaveLength(schemes.length);
    for (const stated of weights) expect(stated).toHaveLength(TINT_NAMES.length);

    const stale: string[] = [];
    for (const [index, scheme] of (['light', 'dark'] as const).entries()) {
      const accent = resolve(schemes[index]!, '--winui-accent-base');
      const surface = resolve(schemes[index]!, '--winui-solid-background-fill-quarternary');
      TINT_NAMES.forEach((name, tint) => {
        const weight = weights[index]![tint]!;
        const declared = schemes[index]!.get(name);
        const expected = blendHex(accent, weight, surface).toLowerCase();
        if (declared !== expected) stale.push(`${scheme} ${name} is ${declared}, but ${accent} at ${Number((weight * 100).toFixed(3))}% over ${surface} is ${expected}`);
      });
    }
    expect(stale).toEqual([]);
  });

  it('keeps the disabled row the share of the text fill its recipe states', () => {
    const schemes = declarationsByScheme(winuiTokenCss);
    // The rule appears once at the top level and once under the dark query, in
    // that order, and the source already carries an alpha of its own.
    const declared = [...listCss.matchAll(/\[aria-disabled='true'\]\s*\{[^}]*?color:\s*(#[0-9a-f]{8})/g)].map(([, hex]) => hex);
    expect(declared).toHaveLength(2);
    const shares = statedShare(listCss, '--winui-text-fill-primary');
    expect(shares).toHaveLength(2);

    const stale: string[] = [];
    for (const [index, scheme] of (['light', 'dark'] as const).entries()) {
      const source = resolve(schemes[index]!, '--winui-text-fill-primary');
      const sourceAlpha = source.length === 9 ? parseInt(source.slice(7, 9), 16) / 255 : 1;
      const share = shares[index]!;
      const expected = `${source.slice(0, 7)}${Math.round(sourceAlpha * share * 255).toString(16).padStart(2, '0')}`;
      if (declared[index] !== expected) stale.push(`${scheme} disabled row is ${declared[index]}, but ${share * 100}% of ${source} is ${expected}`);
    }
    expect(stale).toEqual([]);
  });

  it('reads a channel companion as the channels of its own hex', () => {
    // Guards the two helpers above: a resolve() that silently returned the
    // light value for both schemes would make either check vacuous.
    const schemes = declarationsByScheme(winuiTokenCss);
    expect(resolve(schemes[0]!, '--winui-accent-base')).not.toBe(resolve(schemes[1]!, '--winui-accent-base'));
    expect(rgbBytes(resolve(schemes[0]!, '--winui-accent-base'))).toEqual([0, 103, 192]);
  });
});
