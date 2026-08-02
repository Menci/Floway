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
// Forced colours want the same geometry and get no branch of their own: the
// border box then carries the forced border colour, which is the band a high
// contrast theme draws a control's edge with.

export const winuiResetCss = `
*,
*::before,
*::after {
  background-clip: padding-box;
}
`;

// Cursor is the one surface property this layer leaves to Fluent, and that is a
// departure from WinUI we hold on purpose. Fluent takes the hand on an
// interactive control while the pointer is over it and the barred circle while
// it is disabled -- see the button root and its disabled variant in
// @fluentui/react-button 9.10.1,
// lib/components/Button/useButtonStyles.styles.js, whose hover rule states
// cursor: pointer and whose disabled rules state cursor: not-allowed. Nothing
// here restates or withdraws either.
//
// WinUI appears to disagree only because XAML cannot speak here: the sole
// cursor a UIElement carries is ProtectedCursor, declared protected and with a
// private dependency property modifier, so no Style, theme resource or control
// template in the framework is able to set one and none of them does. That
// silence is a platform without the convention rather than a decision against
// it, and a browser UI whose clickable surfaces keep the arrow reads as inert.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/tools/XCPTypesAutoGen/XamlOM/Model/Microsoft.UI.Xaml.cs#L1160-L1166
//
// A control the layer builds itself, outside Fluent, states the same two and
// nothing else: pointer where the surface acts on a click, not-allowed where it
// is disabled.
