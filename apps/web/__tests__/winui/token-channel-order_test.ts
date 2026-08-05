import { parseHex } from 'culori/fn';
import { describe, expect, it } from 'vitest';

import { winuiTokenCss } from '../../src/winui/tokens';

// The theme dictionaries write colour as AARRGGBB and CSS reads eight digits as
// RRGGBBAA, so a value transcribed verbatim is silently a different colour --
// once, a fully transparent dark red where a 40% black was meant. Both orders
// are valid CSS, so nothing but the eye catches the general case. What is
// catchable is the half that vanishes: a dictionary alpha lands in the blue
// channel and the CSS alpha reads 00, which is never what a named colour wants
// unless it means to be invisible -- and the few that do say so in their name or
// are named here.
const deliberatelyInvisible = new Set([
  // ControlAltFillColorDisabled is 00FFFFFF in both dictionaries: a cavity's
  // disabled step shows the surface behind it rather than a fainter wash.
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L233-L237
  '--winui-control-alt-fill-disabled',
]);

const rgbBytes = (hex: string) => {
  const { r, g, b } = parseHex(hex)!;
  return [r, g, b].map(channel => Math.round(channel * 255));
};

describe('winui token channel order', () => {
  it('gives no token a transparent alpha unless it means to be invisible', () => {
    const invisible = [...winuiTokenCss.matchAll(/(--winui-[a-z0-9-]+):\s*#[0-9a-f]{6}00\b/g)]
      .map(([, name]) => name)
      .filter(name => !name.includes('transparent') && !deliberatelyInvisible.has(name));
    expect(invisible).toEqual([]);
  });

  // A token whose alpha is stated separately publishes its channels beside its
  // hex, and the two spellings are written by hand. Nothing else reads both, so
  // an accent retuned in the hex alone would paint two different blues on one
  // page with no other check firing. A scheme that restates the hex and forgets
  // the companion is the same fault from the other side: the light channels
  // then leak into dark, which is why both directions are checked.
  it('gives every channel companion the channels of the token it sits beside', () => {
    // Declarations for a token and its companion always share a `:root` body,
    // including the one nested in the dark media query.
    const bodies = [...winuiTokenCss.matchAll(/:root\s*\{([^}]*)\}/g)]
      .map(([, body]) => new Map([...body.matchAll(/(--winui-[a-z0-9-]+):\s*([^;]+);/g)]
        .map(([, name, value]) => [name, value.trim()] as const)));
    expect(bodies.length).toBeGreaterThan(0);

    // Every token that carries a companion anywhere carries one everywhere it
    // is stated.
    const companioned = new Set(bodies.flatMap(declared => [...declared.keys()])
      .filter(name => name.endsWith('-rgb'))
      .map(name => name.slice(0, -'-rgb'.length)));
    // Tied to the raw text so a block the parser skips shows up here rather
    // than as a subject that quietly holds nothing.
    expect(companioned).toEqual(new Set([...winuiTokenCss.matchAll(/(--winui-[a-z0-9-]+)-rgb:/g)].map(([, name]) => name)));
    expect(companioned.size).toBeGreaterThan(0);

    const faults: string[] = [];
    for (const declared of bodies) {
      for (const source of companioned) {
        if (declared.has(source) && !declared.has(`${source}-rgb`)) {
          faults.push(`${source} is restated as ${declared.get(source)} with no ${source}-rgb beside it`);
        }
      }
      for (const [name, value] of declared) {
        if (!name.endsWith('-rgb')) continue;
        const source = name.slice(0, -'-rgb'.length);
        const hex = declared.get(source);
        if (hex === undefined) { faults.push(`${name} has no ${source} beside it`); continue; }
        // An indirection is only sound if the companion follows the same token
        // the source does.
        const indirect = /^var\((--winui-[a-z0-9-]+)\)$/.exec(value);
        if (indirect) {
          const expected = `var(${indirect[1]!.slice(0, -'-rgb'.length)})`;
          if (!indirect[1]!.endsWith('-rgb') || hex !== expected) faults.push(`${name} follows ${value} while ${source} follows ${hex}`);
          continue;
        }
        const channels = value.split(',').map(part => Number(part.trim()));
        if (String(channels) !== String(rgbBytes(hex))) faults.push(`${name} is ${value} but ${source} is ${hex}`);
      }
    }
    expect(faults).toEqual([]);
  });
});
