import type { Theme } from '@fluentui/react-components';

import { flowayDarkTheme, flowayLightTheme } from '../theme';

// Shared and status colors have no one-to-one WinUI counterpart and are spent
// per control in ./controls/*.css.ts instead.
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
  colorSubtleBackgroundSelected: 'var(--winui-subtle-fill-secondary)',

  // Every modal surface Fluent dims behind reads one overlay token, and WinUI
  // states one smoke for all of them and the same value in both schemes, where
  // Fluent's darkens with the theme.
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ContentDialog_themeresources.xaml#L7
  colorBackgroundOverlay: 'var(--winui-smoke-fill-default)',

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

  // A neutral foreground and its Hover/Pressed/Selected siblings resolve to one
  // WinUI brush: ListViewItem states TextFillColorPrimaryBrush for every pointer
  // and selection state, and a control whose own template does move the
  // foreground says so in ./controls/*.css.ts. Fluent's stock steps are a
  // separate grey ramp, so leaving a sibling unmapped is what lets a control
  // repaint under the pointer with a colour the layer never chose.
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L23-L28
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L175-L180
  colorNeutralForeground1: 'var(--winui-text-fill-primary)',
  colorNeutralForeground1Hover: 'var(--winui-text-fill-primary)',
  colorNeutralForeground1Pressed: 'var(--winui-text-fill-primary)',
  colorNeutralForeground1Selected: 'var(--winui-text-fill-primary)',
  colorNeutralForeground2: 'var(--winui-text-fill-secondary)',
  colorNeutralForeground2Hover: 'var(--winui-text-fill-secondary)',
  colorNeutralForeground2Pressed: 'var(--winui-text-fill-secondary)',
  colorNeutralForeground2Selected: 'var(--winui-text-fill-secondary)',
  colorNeutralForeground3: 'var(--winui-text-fill-tertiary)',
  colorNeutralForeground3Hover: 'var(--winui-text-fill-tertiary)',
  colorNeutralForeground3Pressed: 'var(--winui-text-fill-tertiary)',
  colorNeutralForeground3Selected: 'var(--winui-text-fill-tertiary)',

  // Fluent's least prominent neutral is what every field paints a placeholder
  // with, and a WinUI placeholder is the secondary text fill. The two other
  // consumers are the colour picker's thumb ring and its empty swatch, and
  // ./controls/color-picker.css.ts states a stroke for both.
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L35
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L48
  colorNeutralForeground4: 'var(--winui-text-fill-secondary)',
  colorNeutralForegroundDisabled: 'var(--winui-text-fill-disabled)',
  colorNeutralForegroundInverted: 'var(--winui-text-fill-inverse)',
  colorNeutralForegroundOnBrand: 'var(--winui-text-on-accent-fill-primary)',

  // WinUI has one accent ramp -- AccentFillColor Default, Secondary and
  // Tertiary, the same base at 100%, 90% and 80% -- and no tinted-accent
  // surface at all: an accent-intent control is a solid accent fill under an
  // on-accent label. Fluent's two brand background ramps therefore land on the
  // same three fills, and the foreground that pairs with the tinted one lands
  // on the on-accent text beside colorNeutralForegroundOnBrand above. The brand
  // and compound-brand strokes walk the same three fills: they are the stroke a
  // Fluent control draws when it is checked, selected or focused, which is the
  // accent brush in every WinUI template that states one. Leaving any of these
  // ramps unmapped is what let a chip, a badge, a tab chip and the colour
  // picker's swatch grid wear Fluent blue beside WinUI accent, and let a dark
  // filled badge pair black on-accent text with Fluent's dark brand fill.
  //
  // The second ramp is the wash rather than the fill, so it lands on the derived
  // accent tint in ../tokens.ts and not on the accent fills: mapping it onto
  // those turns a tinted badge into a solid pill, and leaving it unmapped keeps
  // Microsoft blue beside the accent the operator picked. Stroke2 is that
  // surface's own outline, so it takes the tint's heavier step rather than an
  // on-accent stroke, which would be painting a stroke meant for accent-filled
  // ground onto a nearly-neutral one.
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L36-L38
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L103-L105
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleButton_themeresources.xaml#L11-L13
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/SplitButton/SplitButton_themeresources.xaml#L9-L11
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/SplitButton/SplitButton_themeresources.xaml#L17
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/SplitButton/SplitButton_themeresources.xaml#L32
  colorBrandBackground: 'var(--winui-accent-fill-default)',
  colorBrandBackgroundHover: 'var(--winui-accent-fill-secondary)',
  colorBrandBackgroundPressed: 'var(--winui-accent-fill-tertiary)',
  colorBrandBackgroundSelected: 'var(--winui-accent-fill-default)',
  colorBrandBackground2: 'var(--winui-accent-tint-fill-default)',
  colorBrandBackground2Hover: 'var(--winui-accent-tint-fill-secondary)',
  colorBrandBackground2Pressed: 'var(--winui-accent-tint-fill-tertiary)',
  colorBrandForeground2: 'var(--winui-accent-text-fill-primary)',
  colorBrandStroke1: 'var(--winui-accent-fill-default)',
  colorBrandStroke2: 'var(--winui-accent-tint-stroke)',
  colorCompoundBrandStroke: 'var(--winui-accent-fill-default)',
  colorCompoundBrandStrokeHover: 'var(--winui-accent-fill-secondary)',
  colorCompoundBrandStrokePressed: 'var(--winui-accent-fill-tertiary)',

  // WinUI's focus visual is two concentric strokes, and Fluent spends one token
  // per stroke in the same roles, so the pair is stated here rather than at each
  // focusable control. A control whose Fluent ring needs the strokes swapped or
  // repositioned still says that locally.
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L54-L55
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L258-L259
  colorStrokeFocus1: 'var(--winui-focus-stroke-inner)',
  colorStrokeFocus2: 'var(--winui-focus-stroke-outer)',
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
