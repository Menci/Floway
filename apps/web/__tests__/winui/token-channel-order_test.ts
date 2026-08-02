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

describe('winui token channel order', () => {
  it('gives no token a transparent alpha unless it means to be invisible', () => {
    const invisible = [...winuiTokenCss.matchAll(/(--winui-[a-z0-9-]+):\s*#[0-9a-f]{6}00\b/g)]
      .map(([, name]) => name)
      .filter(name => !name.includes('transparent') && !deliberatelyInvisible.has(name));
    expect(invisible).toEqual([]);
  });
});
