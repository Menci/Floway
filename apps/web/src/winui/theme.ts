import type { Theme } from '@fluentui/react-components';

import { flowayDarkTheme, flowayLightTheme } from '../theme';

// Brand, shared, and status colors have no one-to-one WinUI counterpart and are
// spent per control in ./controls/*.css.ts instead.
//
// One table serves both themes only because the app picks its Fluent theme from
// `prefers-color-scheme` and nothing else (../root.tsx), the same query the
// `--winui-*` dictionaries in ./tokens.ts switch on.
const palette = {
  // WinUI's SolidBackgroundFill ramp is ordered by role, not by lightness, so it
  // maps onto Fluent's ramp by role rather than by step number.
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

  // ControlElevationBorderBrush is a gradient and a Fluent token carries one
  // stop, so all three states resolve to its dominant Default stop; the edge
  // highlight is drawn from --winui-control-elevation-border-color instead.
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

// Fluent's small step keeps its own 2px: WinUI declares no shared radius below
// ControlCornerRadius's 4, and the smaller values it does declare are keyed to
// named parts of a single control, so they belong to the sheets drawing them.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CornerRadius_themeresources.xaml#L13-L15
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L345-L346
const radii = {
  borderRadiusMedium: 'var(--winui-control-corner-radius)',
  borderRadiusLarge: 'var(--winui-overlay-corner-radius)',
  borderRadiusXLarge: 'var(--winui-overlay-corner-radius)',
} as const satisfies Partial<Theme>;

// WinUI draws no drop shadow on inline surfaces, so the ambient elevations are
// zeroed and only the overlay depths (16, 28, 64) are left alone.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L30-L41
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TabView/TabView_themeresources.xaml#L265
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L207
//
// A transparent layer rather than `none`: Fluent builds focus rings as a shadow
// list whose first layer is the elevation, and `none` is only valid as a whole
// box-shadow, so it invalidates the list and drops the focus ring entirely.
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
