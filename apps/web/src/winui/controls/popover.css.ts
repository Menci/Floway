// WinUI 3 FlyoutPresenter styling for Fluent v9's PopoverSurface.
//
// FlyoutContentPadding is deliberately not restated: `size` is composed into
// hashed padding atoms and PopoverSurface is not one of the components
// `winui/appearance.ts` stamps, so stating the padding would flatten all three
// sizes. Nothing is lost by leaving it to Fluent -- `usePopover_unstable` seeds
// `size: 'medium'` before it spreads the caller's props, so a Popover that
// names no size lands on the 16px that FlyoutContentPadding gives the two sides
// it does not split.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/FlyoutPresenter_themeresources.xaml#L20
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-popover/library/src/components/Popover/usePopover.ts#L36-L41
// The Min/Max Width/Height setters read FlyoutThemeMinWidth and its three
// siblings, which the shipping dictionaries never define, so Fluent's
// unconstrained surface stands.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/FlyoutPresenter_themeresources.xaml#L30-L33
//
// FlyoutPresenterBackground is AcrylicInAppFillColorDefaultBrush in both
// dictionaries, taken as the flat colour that brush declares for itself where
// there is no acrylic to composite.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/FlyoutPresenter_themeresources.xaml#L5
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/FlyoutPresenter_themeresources.xaml#L15
export const popoverCss = `
/* WinUI's flyout has one fill and one foreground, so both are stated for every
   appearance -- the doubled class name outranks the atoms Fluent composes for
   its inverted and brand surfaces, which have no WinUI counterpart. Stating
   only the fill left an inverted or brand surface wearing a foreground meant
   for the fill it no longer has, which is unreadable in both themes.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/FlyoutPresenter_themeresources.xaml#L39
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/FlyoutPresenter_themeresources.xaml#L6
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/FlyoutPresenter_themeresources.xaml#L16
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/FlyoutPresenter_themeresources.xaml#L43
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L244 */
.fui-PopoverSurface.fui-PopoverSurface {
  border-radius: var(--winui-overlay-corner-radius);
  border-color: var(--winui-surface-stroke-flyout);
  background-color: var(--winui-acrylic-in-app-fill-default);
  color: var(--winui-text-fill-primary);
}

/* Forced colours already collapse the fill and the stroke onto the system
   colours the HighContrast dictionary names, which leaves the stroke width and
   the elevation. Fluent paints the elevation as a filter, which is not a
   forced-colors property and so keeps painting where a box-shadow would have
   been forced away, and WinUI casts no drop shadow at all while a high
   contrast theme is active.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/FlyoutPresenter_themeresources.xaml#L9-L13
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/components/comptree/HWCompNodeWinRT.cpp#L3962-L3970
   https://drafts.csswg.org/css-color-adjust/#forced-colors-properties */
@media (forced-colors: active) {
  .fui-PopoverSurface.fui-PopoverSurface {
    border-width: 2px;
    filter: none;
  }
}
`;
