import type { Theme } from '@fluentui/react-components';

import { flowayDarkTheme, flowayLightTheme } from '../theme';

// Brand, shared, and status colors stay Fluent's: Fluent fans them across far
// more slots than WinUI declares, so they are spent per control in
// ./controls/*.css.ts rather than mapped one-to-one here.
//
// One table serves both themes only because the app picks its Fluent theme from
// `prefers-color-scheme` and nothing else (../root.tsx), the same query the
// `--winui-*` dictionaries in ./tokens.ts switch on.
const palette = {
  // WinUI's SolidBackgroundFill ramp is ordered by role rather than by
  // lightness, so it is mapped onto Fluent's ramp by role, not by step number.
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

  // Button's rest and hover brush, ControlElevationBorderBrush, is a gradient
  // mapped in absolute units across a 3px span, and a single-valued Fluent token
  // can carry only one stop; over the height of a control the dominant stop is
  // Default, so all three states resolve to it and the edge highlight is dropped.
  // The controls that draw that highlight take it from
  // --winui-control-elevation-border-color instead.
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

// WinUI has exactly two radii where Fluent has four. Fluent's small step keeps
// its own 2px, because WinUI states no shared radius below ControlCornerRadius's
// 4 — the smaller values it declares are keyed to named parts of a single
// control and belong to the sheets that draw those parts.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CornerRadius_themeresources.xaml#L13-L15
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L345-L346
const radii = {
  borderRadiusMedium: 'var(--winui-control-corner-radius)',
  borderRadiusLarge: 'var(--winui-overlay-corner-radius)',
  borderRadiusXLarge: 'var(--winui-overlay-corner-radius)',
} as const satisfies Partial<Theme>;

// WinUI draws no drop shadow on inline surfaces — depth there is carried by the
// elevation border and the background ramp — so the ambient elevations are
// dropped and only the overlay depths (16, 28, 64) are left alone. A subtree that
// opts out of the layer gets all six back in ./controls/card.css.ts.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L30-L41
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TabView/TabView_themeresources.xaml#L265
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L207
//
// A transparent layer rather than `none`, because Fluent composes a focus ring
// out of a shadow LIST whose first layer is the elevation: react-tabs writes
// `box-shadow: var(--shadow4), 0 0 0 2px var(--colorStrokeFocus2)`. `none` is
// valid only as a whole box-shadow, so substituting it makes the list invalid at
// computed-value time and the browser drops the entire declaration -- leaving a
// control with no focus ring at all.
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
