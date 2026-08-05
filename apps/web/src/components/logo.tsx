import { convertHsvToRgb, formatHex } from 'culori/fn';
import type { CSSProperties } from 'react';

import { currentMark } from './logo-mark';
import { fluentComponents } from '../fluent';

const { makeStyles } = fluentComponents;

// Saturation and value are the fixed pink tile's own steps, so that treatment
// fits any mark once only the hue is a variable. Under forced colours the fill
// becomes the system canvas, while the artwork inside stays a replaced element
// with its own colours -- the mark survives, which is the rendering we want.
// https://drafts.csswg.org/css-color-adjust-1/#forced-colors-properties
const SURFACE_LIGHT = [0.133, 0.973] as const;
const SURFACE_DARK = [0.652, 0.361] as const;

const tone = (hue: number, [saturation, value]: readonly [number, number]) =>
  formatHex(convertHsvToRgb({ h: hue, s: saturation, v: value }));

// A style attribute cannot carry a media query, so the root class below picks
// between the two tones.
const paint = (hue: number) => ({
  '--floway-mark-surface-light': tone(hue, SURFACE_LIGHT),
  '--floway-mark-surface-dark': tone(hue, SURFACE_DARK),
  background: 'var(--floway-mark-surface)',
}) as CSSProperties;

const useMarkStyles = makeStyles({
  root: {
    alignItems: 'center',
    // OverlayCornerRadius rather than the control radius: a mark on the page,
    // not a control on it.
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CornerRadius_themeresources.xaml#L6
    borderRadius: '8px',
    display: 'inline-flex',
    height: '36px',
    justifyContent: 'center',
    width: '36px',
    '--floway-mark-surface': 'var(--floway-mark-surface-light)',
    '@media (prefers-color-scheme: dark)': {
      '--floway-mark-surface': 'var(--floway-mark-surface-dark)',
    },
  },
  glyph: { display: 'block', height: '24px', width: '24px' },
});

export function FlowayLogo() {
  const ms = useMarkStyles();
  const mark = currentMark();

  return (
    // The wordmark takes the primary text fill in both themes, as its WinUI
    // counterpart the navigation pane title does.
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView.xaml#L198
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L21
    <div className="inline-flex items-center min-w-0 gap-2.5 text-fui-fg1">
      <span aria-hidden="true" className={ms.root} style={paint(mark.hue)}>
        <img alt="" className={ms.glyph} src={mark.url} />
      </span>
      <span
        className="font-fui-semibold text-fui-base500 leading-[var(--lineHeightBase500)]"
      >
        Floway
      </span>
    </div>
  );
}
