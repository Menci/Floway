import type { Theme } from '@fluentui/react-components';

import { flowayDarkTheme, flowayLightTheme } from '../theme';

// Fluent v9 and WinUI 3 name the same surfaces differently, but a subset of
// Fluent's tokens has an exact WinUI counterpart: the neutral background ramp,
// the neutral strokes, the foreground ramp, the corner radii, and the
// elevation shadows. Overriding just that subset moves the whole component
// library onto WinUI's palette without disturbing the brand, shared, or status
// colors, which WinUI has no matching concept for.
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
  // rest and hover both use ControlElevationBorderBrush, whose heavy stop is
  // ControlStrokeColorSecondary, so hover takes that heavy stop as the closest
  // flat reading of the gradient; pressed drops to the flat
  // ControlStrokeColorDefaultBrush.
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L40
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L138
  colorNeutralStroke1: 'var(--winui-control-stroke-default)',
  colorNeutralStroke1Hover: 'var(--winui-control-stroke-secondary)',
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
// anything inline and OverlayCornerRadius for anything that floats. The small
// step stays on Fluent's own 2px, because the only thing drawn with it here is
// the inline code of Floway's markdown, whose typography this layer leaves
// alone.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CornerRadius_themeresources.xaml#L13-L15
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
const shadows = {
  shadow2: 'none',
  shadow2Brand: 'none',
  shadow4: 'none',
  shadow4Brand: 'none',
  shadow8: 'none',
  shadow8Brand: 'none',
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
