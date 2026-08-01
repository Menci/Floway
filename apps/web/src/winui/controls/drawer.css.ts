// WinUI 3 styling for Fluent v9's Drawer family — both the OverlayDrawer and
// the InlineDrawer the sidebar's NavDrawer renders, plus the header and footer
// separators the two flavours share. WinUI's full-height pane is
// NavigationView's, and it states two surfaces rather than one: the pane that
// overlays the content carries AcrylicInAppFillColorDefaultBrush, while the
// pane that sits beside it is transparent and shows the page it is part of.
// Each flavour here takes the one it corresponds to.
//
// The overlaying pane's fill is the brush FlyoutPresenter also carries, so the
// overlay drawer takes that surface whole: the acrylic brush's flat fallback
// from ../tokens.ts for the fill, the flyout stroke for the outline. The header
// and footer scroll separators are ContentDialog's title separator, that being
// the WinUI surface which likewise carries a title block over scrolling
// content.
export const drawerCss = `
/* Foreground, in place of Fluent's neutral one. Both flavours take WinUI's
   default text brush, which resolves to the primary text fill.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources.xaml#L14 */
.fui-OverlayDrawer.fui-OverlayDrawer,
.fui-InlineDrawer.fui-InlineDrawer {
  color: var(--winui-text-fill-primary);
}

/* An overlay drawer is the pane in its overlaying form, filled with
   AcrylicInAppFillColorDefaultBrush -- the same brush FlyoutPresenter carries,
   which is why the outline below is a flyout's. ../tokens.ts carries the flat
   colour that brush declares as its own fallback.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView.xaml#L289
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L5
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/FlyoutPresenter_themeresources.xaml#L5 */
.fui-OverlayDrawer.fui-OverlayDrawer {
  background-color: var(--winui-acrylic-in-app-fill-default);
}

/* An inline drawer is the pane in its expanded form, which NavigationView
   drives to PaneNotOverlaying: the fill becomes
   SolidBackgroundFillColorTransparent, so what shows through is the page the
   pane is part of, and that page is ApplicationPageBackgroundThemeBrush --
   SolidBackgroundFillColorBase. The resolved colour is named here rather than
   left transparent, so the surface does not depend on whatever the drawer is
   placed over.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView.xaml#L129
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L6
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources.xaml#L13 */
.fui-InlineDrawer.fui-InlineDrawer {
  background-color: var(--winui-solid-background-fill-base);
}

/* The seam an inline drawer makes with the page. WinUI's expanded pane carries
   no edge of its own -- PaneNotOverlaying sets the split view's border
   transparent -- so the hairline between two regions of one page is the divider
   stroke, and it is drawn here from the pane's side. It is painted in every
   state rather than only under Fluent's \`separator\` prop, because the colour
   that prop reaches for is a neutral fill this layer already points at the same
   surface the inline drawer itself takes, so the prop on its own would draw an
   invisible line. The side is Fluent's: it gives a border style to the edge
   facing the content -- inline-end for a start drawer, inline-start for an end
   one -- so this shorthand lands only there. A bottom drawer is the one flavour
   whose styled edge exists only under the prop, and it takes the stroke then.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView.xaml#L127
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L257 */
.fui-InlineDrawer.fui-InlineDrawer {
  border-color: var(--winui-divider-stroke-default);
}

/* The edge facing the page is a flyout border. WinUI strokes all four sides at
   FlyoutBorderThemeThickness 1; only the page-facing edge is painted here,
   because a viewport-anchored drawer's other three edges run along the window
   frame. Fluent gives a border style to exactly that side -- the right edge for
   a start drawer, the left for an end one, none at all for a bottom one -- so
   this shorthand reaches it and the style-less sides stay unpainted. Two losses
   come with painting one edge: a bottom drawer takes no stroke at all, and
   while focus is visible Fluent blanks the same border to complete its focus
   ring, so the override stands aside for that state and the edge goes with it.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/FlyoutPresenter_themeresources.xaml#L6-L7 */
.fui-OverlayDrawer.fui-OverlayDrawer:not([data-fui-focus-visible]) {
  border-color: var(--winui-surface-stroke-flyout);
}

/* High contrast. FlyoutPresenter's HighContrast dictionary doubles the stroke
   to 2px, because the surface fill and the page behind it collapse onto the
   same system Window colour there and the stroke is all that divides them.
   Forced colours collapse the two fills the same way and leave widths alone,
   so the width is the one value restated; the brushes that dictionary names
   are already what forced colours make of the fill and the stroke. Only the
   page-facing edge carries a border style, so this reaches that edge alone,
   and a bottom drawer, which has no styled edge, gains nothing here either.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/FlyoutPresenter_themeresources.xaml#L9-L12
   https://drafts.csswg.org/css-color-adjust/#forced-colors-properties */
@media (forced-colors: active) {
  .fui-OverlayDrawer.fui-OverlayDrawer {
    border-width: 2px;
  }
}

/* Fluent's drawer focus ring is the single \`::after\` outline in
   --colorStrokeFocus2, so retinting that token gives it WinUI's outer focus
   stroke. WinUI's visual is a two-ring composite, and the inner ring is an
   inset shadow because it has to sit inside the outer ring's own border box --
   the drawer's own border exists on one side only, so it cannot carry it. The
   two thicknesses are the framework defaults, which this corpus states only
   where ListViewItem restates them. Forced colours are left to Fluent and the
   user agent: Fluent states Highlight for the ring itself there, and the inner
   ring is a box shadow, a property forced colours drop.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L258-L259
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L251-L253
   https://drafts.csswg.org/css-color-adjust/#forced-colors-properties */
.fui-OverlayDrawer.fui-OverlayDrawer[data-fui-focus-visible] {
  --colorStrokeFocus2: var(--winui-focus-stroke-outer);
}

.fui-OverlayDrawer.fui-OverlayDrawer[data-fui-focus-visible]::after {
  box-shadow: inset 0 0 0 1px var(--winui-focus-stroke-inner);
}

/* Fluent makes every DrawerBody an unconditional browser scroll owner. Floway
   composes each production body around an explicit ScrollArea, so the parent
   must remain a clipped layout cell; otherwise a one-pixel rounding overflow
   can expose a second native scrollbar beside the OverlayScrollbars viewport.
   https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-drawer/library/src/components/DrawerBody/useDrawerBodyStyles.styles.ts#L15-L28 */
.fui-DrawerBody.fui-DrawerBody {
  min-height: 0;
  overflow: hidden;
}

/* The hairline that appears once the body scrolls is WinUI's ContentDialog
   title separator, a card stroke rather than a neutral one, and it fades on
   WinUI's normal control timing instead of Fluent's. Header and footer share
   one style module, differing only in which pseudo-element carries it, so both
   are named to keep the two hairlines one colour. Fluent generates the
   pseudo-element only while the body is scrollable, so naming it
   unconditionally restyles it without bringing it into existence.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ContentDialog_themeresources.xaml#L44
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L602-L603 */
.fui-DrawerHeader.fui-DrawerHeader::after,
.fui-DrawerFooter.fui-DrawerFooter::before {
  background-color: var(--winui-card-stroke-default);
  transition-duration: var(--winui-control-normal-animation-duration);
  transition-timing-function: var(--winui-control-fast-out-slow-in-easing);
}
`;
