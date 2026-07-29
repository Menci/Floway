import type { Theme } from '@fluentui/react-components';

import { flowayDarkTheme, flowayLightTheme } from '../theme';

// Fluent v9 and WinUI 3 name the same surfaces differently, but a subset of
// Fluent's tokens has an exact WinUI counterpart: the neutral background ramp,
// the neutral strokes, the foreground ramp, the corner radii, and the
// elevation shadows. Overriding just that subset moves the whole component
// library onto WinUI's palette without disturbing the brand, shared, or status
// colors, which WinUI has no matching concept for.
//
// Values are the XAML literals with the leading alpha byte moved to the end,
// matching the conversion documented in ./tokens.ts.

// WinUI's SolidBackgroundFill ramp is ordered by role rather than by
// lightness, so it is mapped onto Fluent's ramp by role: Quarternary is the
// raised card surface Fluent calls Background1, Base is the page canvas, and
// BaseAlt is the deepest step. The hover and pressed steps come from the
// control fills, which WinUI composites over whichever surface is beneath.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L219-L279
const lightBackgrounds = {
  colorNeutralBackground1: '#ffffff',
  colorNeutralBackground1Hover: '#f9f9f980',
  colorNeutralBackground1Pressed: '#f9f9f94d',
  colorNeutralBackground2: '#f9f9f9',
  colorNeutralBackground3: '#f3f3f3',
  colorNeutralBackground4: '#eeeeee',
  colorNeutralBackground5: '#dadada',
  colorSubtleBackground: '#ffffff00',
  colorSubtleBackgroundHover: '#00000009',
  colorSubtleBackgroundPressed: '#00000006',
} as const satisfies Partial<Theme>;

// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L15-L75
const darkBackgrounds = {
  colorNeutralBackground1: '#2c2c2c',
  colorNeutralBackground1Hover: '#ffffff15',
  colorNeutralBackground1Pressed: '#ffffff08',
  colorNeutralBackground2: '#282828',
  colorNeutralBackground3: '#202020',
  colorNeutralBackground4: '#1c1c1c',
  colorNeutralBackground5: '#0a0a0a',
  colorSubtleBackground: '#ffffff00',
  colorSubtleBackgroundHover: '#ffffff0f',
  colorSubtleBackgroundPressed: '#ffffff0a',
} as const satisfies Partial<Theme>;

// Fluent's three neutral strokes correspond to WinUI's control outline, card
// outline, and divider; the accessible stroke is WinUI's strong stroke, the
// one it also paints the text-control underline with.
//
// The interaction steps come from Button, which is where WinUI states them:
// rest and hover both use ControlElevationBorderBrush, whose heavy stop is
// ControlStrokeColorSecondary, so hover is set to that heavy stop as the
// closest flat reading of the gradient; pressed drops to the flat
// ControlStrokeColorDefaultBrush and is transcribed exactly.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L243-L257
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L138
const lightStrokes = {
  colorNeutralStroke1: '#0000000f',
  colorNeutralStroke1Hover: '#00000029',
  colorNeutralStroke1Pressed: '#0000000f',
  colorNeutralStroke2: '#0000000f',
  colorNeutralStroke3: '#0000000f',
  colorNeutralStrokeAccessible: '#00000072',
  colorNeutralStrokeDisabled: '#00000037',
} as const satisfies Partial<Theme>;

// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L39-L53
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L40
const darkStrokes = {
  colorNeutralStroke1: '#ffffff12',
  colorNeutralStroke1Hover: '#ffffff18',
  colorNeutralStroke1Pressed: '#ffffff12',
  colorNeutralStroke2: '#00000019',
  colorNeutralStroke3: '#ffffff15',
  colorNeutralStrokeAccessible: '#ffffff8b',
  colorNeutralStrokeDisabled: '#ffffff28',
} as const satisfies Partial<Theme>;

// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L209-L217
const lightForegrounds = {
  colorNeutralForeground1: '#000000e4',
  colorNeutralForeground2: '#0000009e',
  colorNeutralForeground3: '#00000072',
  colorNeutralForegroundDisabled: '#0000005c',
  colorNeutralForegroundInverted: '#ffffff',
  colorNeutralForegroundOnBrand: '#ffffff',
} as const satisfies Partial<Theme>;

// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L5-L13
const darkForegrounds = {
  colorNeutralForeground1: '#ffffff',
  colorNeutralForeground2: '#ffffffc5',
  colorNeutralForeground3: '#ffffff87',
  colorNeutralForegroundDisabled: '#ffffff5d',
  colorNeutralForegroundInverted: '#000000e4',
  colorNeutralForegroundOnBrand: '#000000',
} as const satisfies Partial<Theme>;

// WinUI states its type ramp as named TextBlock styles rather than as a
// numbered scale: Caption 12, Body 14, Body Large 18, Subtitle 20, Title 28,
// Title Large 40, Display 68. Floway promotes Fluent's Base200 text to Body
// 14/20 so secondary labels remain readable; Base300 already occupies the same
// Body step. The 16px step falls between Body and Body Large with nothing to
// move it onto.
//
// The fifth is the one that matters here. Fluent sizes DialogTitle from
// fontSizeBase500, which is the Subtitle slot, and pairs it with a 28px line
// height that only reads right at 20px. Restoring it puts every dialog title,
// and everything else drawn at that step, back on Windows' Subtitle.
//
// The 600 step is left alone deliberately: WinUI's next size up is Title at
// 28, and promoting the step that far would resize headings this dashboard
// tuned for its own density rather than for a Windows shell.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBlock_themeresources.xaml
const typeRamp = {
  fontSizeBase500: '20px',
} as const satisfies Partial<Theme>;

// WinUI has exactly two radii where Fluent has four: ControlCornerRadius for
// anything inline and OverlayCornerRadius for anything that floats.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CornerRadius_themeresources.xaml#L13-L15
const radii = {
  borderRadiusSmall: '4px',
  borderRadiusMedium: '4px',
  borderRadiusLarge: '8px',
  borderRadiusXLarge: '8px',
} as const satisfies Partial<Theme>;

// WinUI draws no drop shadow on inline surfaces — depth there is carried by
// the elevation border and the background ramp — so the ambient elevations are
// dropped. Button is the witness: it declares a background, a foreground, and
// ControlElevationBorderBrush as its border, and no shadow resource at all.
// The only shadow depths the dictionaries declare belong to overlay surfaces,
// so the flyout and dialog elevations (16, 28, 64) are left alone.
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
  ...lightBackgrounds,
  ...lightStrokes,
  ...lightForegrounds,
  ...typeRamp,
  ...radii,
  ...shadows,
};

export const winuiDarkTheme: Theme = {
  ...flowayDarkTheme,
  ...darkBackgrounds,
  ...darkStrokes,
  ...darkForegrounds,
  ...typeRamp,
  ...radii,
  ...shadows,
};
