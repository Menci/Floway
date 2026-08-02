// WinUI 3 FlyoutPresenter styling for Fluent v9's PopoverSurface. Fluent paints
// the surface as a Fluent 2 Web card — control-sized corners, a transparent
// hairline, an ambient plus key drop shadow — while WinUI paints a flyout: the
// larger overlay corner, a real flyout stroke, and a fill that stops at the
// inner border edge so the translucent stroke reads at its own strength.
//
// The unit has one addressable element. `Popover` renders no DOM of its own and
// `PopoverTrigger` clones its child, so `.fui-PopoverSurface` is the whole
// surface; the arrow is rendered from `state.arrowClassName`, which is Griffel
// atoms with no stable class to name. The arrow still takes the WinUI fill,
// because Fluent gives it `background-color: inherit` and the surface is its
// parent; only its own hairline stays Fluent's.
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-positioning/library/src/createArrowStyles.ts#L76-L77
//
// Fluent declares no interactive state for the surface -- no hover, pressed,
// selected, disabled or focus atom -- and WinUI's DefaultFlyoutPresenterStyle
// declares no VisualStateGroup and leaves IsTabStop False, so the state table
// is the theme rows alone: light and dark, which the `--winui-*` fills below
// carry per scheme, and high contrast, which is restated at the end of this
// sheet.
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
// for itself where there is no acrylic to composite. The foreground stays
// Fluent's.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/FlyoutPresenter_themeresources.xaml#L5
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/FlyoutPresenter_themeresources.xaml#L15
export const popoverCss = `
/* The surface. WinUI gives a flyout the overlay corner rather than the control
   corner, and outlines it with the flyout stroke where Fluent draws a
   transparent hairline. The template's Border sizes its background to the inner
   border edge, which ../reset.css.ts already applies to everything and which
   keeps the translucent stroke from compositing over the fill beneath it.
   WinUI's flyout has one fill, so it is stated for every appearance -- the
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
