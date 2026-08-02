// A XAML element paints its Background to the inner edge of its BorderThickness
// (BackgroundSizing defaults to InnerBorderEdge) while CSS paints it under the
// border as well, so at the CSS default every outlined control reads heavier
// than WinUI's.
// https://learn.microsoft.com/en-us/windows/windows-app-sdk/api/winrt/microsoft.ui.xaml.controls.control.backgroundsizing
// https://learn.microsoft.com/en-us/windows/windows-app-sdk/api/winrt/microsoft.ui.xaml.controls.backgroundsizing
//
// The toggle buttons' checked states swap to OuterBorderEdge and restate that in
// controls/button.css.ts.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleButton_themeresources.xaml#L255-L256
//
// :where() holds each row at the universal selector's weight, so anything
// stating a background-clip of its own wins whatever order the sheets are
// injected in.
import { notOptedOut } from './tokens';

export const winuiResetCss = `
*:where(${notOptedOut}),
*:where(${notOptedOut})::before,
*:where(${notOptedOut})::after {
  background-clip: padding-box;
}
`;
