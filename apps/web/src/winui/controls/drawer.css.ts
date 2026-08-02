// WinUI 3 styling for Fluent v9's Drawer family — both the OverlayDrawer and
// the InlineDrawer the sidebar's NavDrawer renders. WinUI's full-height pane is
// NavigationView's, and it states two surfaces rather than one: the pane that
// overlays the content carries AcrylicInAppFillColorDefaultBrush, while the
// pane that sits beside it is transparent and shows the page it is part of.
// Each flavour here takes the one it corresponds to.
//
// The overlaying pane's fill is the brush FlyoutPresenter also carries, so the
// overlay drawer takes that surface whole: the acrylic brush's flat fallback
// from ../tokens.ts for the fill, the flyout stroke for the outline.
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

/* An inline drawer's page-facing edge carries no seam. WinUI's expanded pane
   states no edge of its own -- PaneNotOverlaying sets the split view's border
   transparent -- and the hairline a NavigationView shows at that boundary is
   drawn from the content side: ContentGrid is a card, with 1,1,0,0 of
   CardStrokeColorDefault under an 8,0,0,0 radius over LayerFillColorDefault,
   and the seam is that card's start edge. Nothing this drawer sits beside is
   that card, so the seam has no owner and Fluent's transparent border is left
   as it stands. ./nav.css.ts clears the same edge on the sidebar's NavDrawer.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView.xaml#L127
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView.xaml#L392
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L49
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L234 */

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
   where ListViewItem restates them.

   Fluent puts that pseudo-element two pixels outside the drawer, and the
   drawer clips: it is the outermost box of the overlay, and with square
   corners nothing of a ring drawn outside it survives at all. The
   pseudo-element is pulled onto the drawer's padding box instead, so the pair
   is drawn inward and lands whole inside the clip.

   Forced colours are left to Fluent and the user agent: Fluent states
   Highlight for the ring itself there, and the inner ring is a box shadow, a
   property forced colours drop.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L258-L259
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L251-L253
   https://drafts.csswg.org/css-color-adjust/#forced-colors-properties */
.fui-OverlayDrawer.fui-OverlayDrawer[data-fui-focus-visible] {
  --colorStrokeFocus2: var(--winui-focus-stroke-outer);
}

.fui-OverlayDrawer.fui-OverlayDrawer[data-fui-focus-visible]::after {
  inset: 0;
  box-shadow: inset 0 0 0 1px var(--winui-focus-stroke-inner);
}

/* Fluent makes every DrawerBody an unconditional browser scroll owner. Floway
   composes each production body around an explicit ScrollArea, so the parent
   must remain a clipped layout cell; otherwise a one-pixel rounding overflow
   can expose a second native scrollbar beside the OverlayScrollbars viewport.
   Fluent reads the header's and footer's scroll separators off that same
   element, so a body that never scrolls never carries them either: the scroll,
   and anything that belongs to it, is the ScrollArea's.

   Fluent's padding on that element is 0 24px, plus 25px added back on
   whichever block edge is a first or last child. A body that follows a
   DrawerHeader is neither first nor last, so it gets nothing on top and
   nothing at the bottom, and a control at its edge has its focus ring cut by
   the clip this rule installs. Squaring the block padding at 25px gives the
   clip the same room inside it on both ends, and matches what Fluent already
   gives a body that is the only child. A production body passes \`!p-0\` and
   nests its own padded ScrollArea, so this reaches the plain bodies alone.
   https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-drawer/library/src/components/DrawerBody/useDrawerBodyStyles.styles.ts#L16-L31 */
.fui-DrawerBody.fui-DrawerBody {
  min-height: 0;
  overflow: hidden;
  padding-block: 25px;
}
`;
