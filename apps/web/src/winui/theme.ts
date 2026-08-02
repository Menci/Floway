import type { Theme } from '@fluentui/react-components';

import { flowayDarkTheme, flowayLightTheme } from '../theme';

// Fluent v9 and WinUI 3 name the same surfaces differently, but a subset of
// Fluent's tokens has an exact WinUI counterpart: the neutral background ramp,
// the neutral strokes, the foreground ramp, the corner radii, and the
// elevation shadows. Overriding just that subset moves the whole component
// library onto WinUI's palette, and leaves the brand, shared, and status colors
// to Fluent. Fluent's shared hue ramps have no WinUI equivalent at all; accent
// and status do — AccentFillColor* and SystemFillColor*, both transcribed in
// ./tokens.ts — but Fluent fans each of them across far more slots than WinUI
// declares, so they are spent per control in ./controls/*.css.ts rather than
// mapped one-to-one here.
//
// Every value here is a `var(--winui-*)` reference rather than a literal.
// ./tokens.ts is the one transcription of the XAML dictionaries and this file is
// a mapping of Fluent's vocabulary onto it, so each value is stated, and cited,
// exactly once. The indirection holds because the app picks its Fluent theme
// from `prefers-color-scheme` and nothing else (../root.tsx), which is the
// query the token dictionaries themselves switch on: the light theme is never
// rendered while the dark values are live. That also collapses the light and
// dark halves of the mapping into one table — the values differ by theme, the
// roles do not.
const palette = {
  // WinUI's SolidBackgroundFill ramp is ordered by role rather than by
  // lightness, so it is mapped onto Fluent's ramp by role: Quarternary is the
  // raised card surface Fluent calls Background1, Base is the page canvas, and
  // BaseAlt is the deepest step. The hover and pressed steps come from the
  // control fills, which WinUI composites over whichever surface is beneath.
  colorNeutralBackground1: 'var(--winui-solid-background-fill-quarternary)',
  colorNeutralBackground1Hover: 'var(--winui-control-fill-secondary)',
  colorNeutralBackground1Pressed: 'var(--winui-control-fill-tertiary)',
  colorNeutralBackground2: 'var(--winui-solid-background-fill-tertiary)',
  colorNeutralBackground3: 'var(--winui-solid-background-fill-base)',
  colorNeutralBackground4: 'var(--winui-solid-background-fill-secondary)',
  colorNeutralBackground5: 'var(--winui-solid-background-fill-base-alt)',
  colorSubtleBackground: 'var(--winui-subtle-fill-transparent)',
  colorSubtleBackgroundHover: 'var(--winui-subtle-fill-secondary)',
  colorSubtleBackgroundPressed: 'var(--winui-subtle-fill-tertiary)',

  // Fluent's three neutral strokes correspond to WinUI's control outline, card
  // outline, and divider; the accessible stroke is WinUI's strong stroke, the
  // one it also paints the text-control underline with.
  //
  // The interaction steps come from Button, which is where WinUI states them:
  // rest and hover are the same brush, ControlElevationBorderBrush, and pressed
  // is the flat ControlStrokeColorDefaultBrush. That brush is a gradient mapped
  // in absolute units across a 3px span, so ControlStrokeColorSecondary covers
  // roughly one pixel at one edge — the top in dark, the bottom in light, which
  // flips the gradient — and ControlStrokeColorDefault covers the rest. A
  // single-valued Fluent token can carry one of the two stops, and over the
  // height of a control the dominant one is Default, so all three states
  // resolve to it and the edge highlight is dropped. The controls that draw
  // that highlight take it from --winui-control-elevation-border-color, which
  // ./tokens.ts composes as a three-term border-color shorthand.
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L38-L40
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L136-L138
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L186-L191
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L382-L390
  colorNeutralStroke1: 'var(--winui-control-stroke-default)',
  colorNeutralStroke1Hover: 'var(--winui-control-stroke-default)',
  colorNeutralStroke1Pressed: 'var(--winui-control-stroke-default)',
  colorNeutralStroke2: 'var(--winui-card-stroke-default)',
  colorNeutralStroke3: 'var(--winui-divider-stroke-default)',
  colorNeutralStrokeAccessible: 'var(--winui-control-strong-stroke-default)',
  colorNeutralStrokeDisabled: 'var(--winui-control-strong-stroke-disabled)',

  colorNeutralForeground1: 'var(--winui-text-fill-primary)',
  colorNeutralForeground2: 'var(--winui-text-fill-secondary)',
  colorNeutralForeground3: 'var(--winui-text-fill-tertiary)',
  colorNeutralForegroundDisabled: 'var(--winui-text-fill-disabled)',
  colorNeutralForegroundInverted: 'var(--winui-text-fill-inverse)',
  colorNeutralForegroundOnBrand: 'var(--winui-text-on-accent-fill-primary)',
} as const satisfies Partial<Theme>;

// WinUI has exactly two radii where Fluent has four: ControlCornerRadius for
// anything inline and OverlayCornerRadius for anything that floats. Fluent's
// small step keeps its own 2px, because WinUI states no shared radius below
// ControlCornerRadius's 4 — the smaller values it does declare, 3 and 1.5, are
// keyed to named parts of a single control and belong to the sheets that draw
// those parts. Fluent spends the small step on the tooltip arrow's tip and on
// the focus ring of every size="small" button.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CornerRadius_themeresources.xaml#L13-L15
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L345-L346
const radii = {
  borderRadiusMedium: 'var(--winui-control-corner-radius)',
  borderRadiusLarge: 'var(--winui-overlay-corner-radius)',
  borderRadiusXLarge: 'var(--winui-overlay-corner-radius)',
} as const satisfies Partial<Theme>;

// WinUI draws no drop shadow on inline surfaces — depth there is carried by
// the elevation border and the background ramp — so the ambient elevations are
// dropped. Button is the witness: it declares a background, a foreground, and
// ControlElevationBorderBrush as its border, and no shadow resource at all.
// The only shadow depths the dictionaries declare belong to overlay surfaces,
// so the flyout and dialog elevations (16, 28, 64) are left alone. A subtree
// that opts out of the layer gets all six back in ./controls/card.css.ts.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L30-L41
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TabView/TabView_themeresources.xaml#L265
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L207
//
// Written as a transparent layer rather than as `none`, because these tokens are
// not only spent on their own. Fluent composes a focus ring out of a shadow
// LIST whose first layer is the elevation: react-tabs writes
// `box-shadow: var(--shadow4), 0 0 0 2px var(--colorStrokeFocus2)` and
// react-button writes the same shape around `--shadow2`. `none` is valid only
// as a whole box-shadow, so substituting it makes the list invalid at
// computed-value time and the browser drops the entire declaration -- not a
// flat control, a control with no focus ring at all. Measured before this
// change, a focused `.fui-Tab` computed `box-shadow: none` and carried only
// Fluent's `outline: 2px solid transparent` forced-colours placeholder, so a
// keyboard reader had nothing to follow.
//
// A fully transparent shadow paints exactly what `none` painted and keeps the
// list valid, so the ring survives while the elevation stays gone.
const shadows = {
  shadow2: '0 0 #0000',
  shadow2Brand: '0 0 #0000',
  shadow4: '0 0 #0000',
  shadow4Brand: '0 0 #0000',
  shadow8: '0 0 #0000',
  shadow8Brand: '0 0 #0000',
} as const satisfies Partial<Theme>;

export const winuiLightTheme: Theme = {
  ...flowayLightTheme,
  ...palette,
  ...radii,
  ...shadows,
};

export const winuiDarkTheme: Theme = {
  ...flowayDarkTheme,
  ...palette,
  ...radii,
  ...shadows,
};
