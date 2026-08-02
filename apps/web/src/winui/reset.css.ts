// Where a fill stops — the one place this layer corrects a difference between
// the two box models rather than between the two design languages.
//
// A XAML element paints its Background to the inner edge of its BorderThickness
// (BackgroundSizing defaults to InnerBorderEdge) while CSS paints it under the
// border as well. Every stroke in this vocabulary is a translucent white or
// black over a translucent fill, so left at the CSS default the two compose and
// every outlined control reads heavier than WinUI's.
// https://learn.microsoft.com/en-us/windows/windows-app-sdk/api/winrt/microsoft.ui.xaml.controls.control.backgroundsizing
// https://learn.microsoft.com/en-us/windows/windows-app-sdk/api/winrt/microsoft.ui.xaml.controls.backgroundsizing
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L199
//
// Stated once for everything rather than per control: the difference belongs to
// the mapping, and a list of the controls that pair a fill with a stroke today
// would silently miss the next one. No theme or state branch is needed, because
// BackgroundSizing is geometry and no theme dictionary keys it; the only
// templates that move it between visual states are the toggle buttons, whose
// checked states swap to OuterBorderEdge and restate that in
// controls/button.css.ts.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleButton_themeresources.xaml#L255-L256
//
// The opt-out sits inside :where() so each row weighs no more than the universal
// selector, and anything stating a background-clip of its own wins whatever
// order the sheets are injected in.
import { notOptedOut } from './tokens';

export const winuiResetCss = `
*:where(${notOptedOut}),
*:where(${notOptedOut})::before,
*:where(${notOptedOut})::after {
  background-clip: padding-box;
}
`;
