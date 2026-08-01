import { currentMark } from './logo-mark';
import { fluentComponents } from '../fluent';
import { hsvToRgb, rgbToHex } from '../lib/color';

const { makeStyles } = fluentComponents;

// The tile, as saturation and value against whichever hue was drawn. Both steps
// are the fixed pink tile's own, read back off it: it already sat at a single
// hue, so only the hue had to become a variable for the same treatment to fit
// any mark. A cherry blossom therefore lands a few degrees from the tile this
// replaces, and every other mark is that tile in its own colour.
//
// The tile carries no border: its fill against the surface behind it is what
// states the shape, and an outline would need a third step per hue to draw an
// edge the fill already draws.
//
// Under forced colours the fill is replaced by the system canvas whatever this
// writes, so the tile stops reading as a tile -- but the artwork inside it is a
// replaced element and keeps its own colours, which leaves the mark itself
// intact and is the rendering we want there.
// https://drafts.csswg.org/css-color-adjust-1/#forced-colors-properties
const SURFACE_LIGHT = [0.133, 0.973] as const;
const SURFACE_DARK = [0.652, 0.361] as const;

const tone = (hue: number, [saturation, value]: readonly [number, number]) =>
  rgbToHex(...hsvToRgb(hue, saturation, value));

const paint = (hue: number) => ({
  background: `light-dark(${tone(hue, SURFACE_LIGHT)}, ${tone(hue, SURFACE_DARK)})`,
});

const useMarkStyles = makeStyles({
  root: {
    alignItems: 'center',
    // The tile takes OverlayCornerRadius rather than the control radius: it is a
    // mark on the page, not a control on it.
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CornerRadius_themeresources.xaml#L6
    borderRadius: '8px',
    display: 'inline-flex',
    height: '36px',
    justifyContent: 'center',
    width: '36px',
  },
  glyph: { display: 'block', height: '24px', width: '24px' },
});

export function FlowayLogo() {
  const ms = useMarkStyles();
  const mark = currentMark();

  return (
    // The wordmark takes the primary text fill in both themes. Its WinUI
    // counterpart is the navigation pane's title, which draws in
    // `NavigationViewItemForeground` -- `TextFillColorPrimaryBrush` in the
    // Default (dark) and Light dictionaries alike -- so the app's own name is
    // never a secondary step.
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
