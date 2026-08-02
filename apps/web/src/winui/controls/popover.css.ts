// WinUI 3 FlyoutPresenter styling for Fluent v9's PopoverSurface.
//
// The arrow has no stable class -- it is rendered from `state.arrowClassName`,
// hashed Griffel atoms -- but takes the WinUI fill anyway, because Fluent gives
// it `background-color: inherit` and the surface is its parent.
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-positioning/library/src/createArrowStyles.ts#L76-L77
//
// Two WinUI rows are diagnosed and deliberately left out. FlyoutContentPadding
// is 16,15,16,17 against Fluent's flat 12/16/20px, but `size` is composed into
// hashed padding atoms and PopoverSurface is not one of the components
// `winui/appearance.ts` stamps, so no selector can address one size; restating
// the padding on the root would flatten all three.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/FlyoutPresenter_themeresources.xaml#L20
// The MinWidth/MaxWidth/MinHeight/MaxHeight setters read FlyoutThemeMinWidth and
// its three siblings, which the shipping dictionaries reference but never
// define, so the sizes they resolve to are not knowable from the theme resources
// and Fluent's unconstrained surface stands.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/FlyoutPresenter_themeresources.xaml#L30-L33
//
// FlyoutPresenterBackground is AcrylicInAppFillColorDefaultBrush in both the
// dark and the light dictionary, taken as the flat colour that brush declares
// for itself where there is no acrylic to composite.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/FlyoutPresenter_themeresources.xaml#L5
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/FlyoutPresenter_themeresources.xaml#L15
export const popoverCss = `
/* WinUI's flyout has one fill, so it is stated for every appearance -- the
   doubled class name outranks the atoms Fluent composes for its inverted and
   brand surfaces, which have no WinUI counterpart.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/FlyoutPresenter_themeresources.xaml#L39
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/FlyoutPresenter_themeresources.xaml#L6
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/FlyoutPresenter_themeresources.xaml#L16
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/FlyoutPresenter_themeresources.xaml#L43 */
.fui-PopoverSurface.fui-PopoverSurface {
  border-radius: var(--winui-overlay-corner-radius);
  border-color: var(--winui-surface-stroke-flyout);
  background-color: var(--winui-acrylic-in-app-fill-default);
}

/* High contrast. FlyoutPresenter's HighContrast dictionary doubles the stroke
   to 2px, because the surface fill and the page behind it collapse onto the
   same system Window colour there and the stroke is all that divides them.
   Forced colours collapse the two fills the same way and leave widths alone,
   so the width is the one value restated; the two brushes that dictionary
   names are already what forced colours make of the fill and the stroke.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/FlyoutPresenter_themeresources.xaml#L9-L13
   https://drafts.csswg.org/css-color-adjust/#forced-colors-properties */
@media (forced-colors: active) {
  .fui-PopoverSurface.fui-PopoverSurface {
    border-width: 2px;
  }
}
`;
