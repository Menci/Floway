// Toolbar and ToolbarButton, restyled from Fluent 2 Web onto WinUI 3.
//
// Rest, hover, pressed, disabled, focus and checked are left to `button.css.ts`
// at the subtle appearance `winui/appearance.ts` stamps on the item: AppBarButton
// and AppBarToggleButton resolve their state tables onto the brushes
// SubtleButtonStyle already spends, key for key in both schemes, and hand
// HighContrast to the system brushes as Fluent's forced-colours atoms do.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/AppBarButton_themeresources.xaml#L4-L38
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/AppBarToggleButton_themeresources.xaml#L9-L12
//
// The container keeps Fluent's flex row rather than WinUI's CommandBar geometry
// -- 68-wide glyph-over-label items on a 40px AppBarThemeCompactHeight row with
// an overflow flyout -- because the dashboard's toolbars are short inline groups
// beside a heading. The restyle stops at the typography the bar shares with its
// items; that line is ours, not one WinUI draws.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/themes/generic.xaml#L19126-L19134
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/themes/generic.xaml#L26

export const toolbarCss = `
/* A command bar item's label runs at 12, two steps below the 14 Fluent's button
   reset uses: AppBarButton states it on its own TextLabel and
   SplitButtonCommandBarStyle repeats it as a Setter, in neither case from a
   visual state, so one value covers every state and both schemes. The selector
   also catching a plain Button, a MenuButton trigger or either half of a
   SplitButton hosted in a toolbar is the intent -- WinUI states this typography
   by host, not by control -- and so is its reaching a toolbar at any Fluent
   size. The line box stays Fluent's 20px: neither control states a LineHeight,
   and taking the 16px step that pairs with 12px would shrink the item from 32px
   to 28, further from the 40px command bar row than Fluent's 32 already is.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/themes/generic.xaml#L19402-L19406
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/SplitButton/SplitButton_themeresources.xaml#L104-L119 */
.fui-Toolbar .fui-Button.fui-Button {
  font-size: var(--fontSizeBase200);
}
`;
