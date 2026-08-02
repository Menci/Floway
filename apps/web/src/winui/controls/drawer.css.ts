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

/* An inline drawer is the pane in its expanded form, whose fill is transparent
   so that the page behind it shows through. The colour that page resolves to is
   named here rather than left transparent, so the surface does not depend on
   whatever the drawer is placed over.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView.xaml#L129
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L6
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources.xaml#L13 */
.fui-InlineDrawer.fui-InlineDrawer {
  background-color: var(--winui-solid-background-fill-base);
}

/* An inline drawer's page-facing edge carries no seam. WinUI's expanded pane
   states no edge of its own, and the hairline a NavigationView shows at that
   boundary is drawn from the content side, as the start edge of the content
   card. Nothing this drawer sits beside is that card, so the seam has no owner
   and Fluent's transparent border stands.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView.xaml#L127
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView.xaml#L392
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L49
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L234 */

/* The edge facing the page is a flyout border. WinUI strokes all four sides;
   only the page-facing edge is painted here, because a viewport-anchored
   drawer's other three edges run along the window frame, and it is the one side
   Fluent gives a border style to. Two losses come with that: a bottom drawer
   takes no stroke at all, and while focus is visible Fluent blanks the same
   border to complete its focus ring, so the override stands aside for that state
   and the edge goes with it.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/FlyoutPresenter_themeresources.xaml#L6-L7 */
.fui-OverlayDrawer.fui-OverlayDrawer:not([data-fui-focus-visible]) {
  border-color: var(--winui-surface-stroke-flyout);
}

/* High contrast. WinUI doubles the stroke to 2px, because the surface fill and
   the page behind it collapse onto the same system Window colour there and the
   stroke is all that divides them. Forced colours collapse the two fills the
   same way and leave widths alone, so the width is the one value restated.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/FlyoutPresenter_themeresources.xaml#L9-L12
   https://drafts.csswg.org/css-color-adjust/#forced-colors-properties */
@media (forced-colors: active) {
  .fui-OverlayDrawer.fui-OverlayDrawer {
    border-width: 2px;
  }
}

/* Fluent's drawer focus ring is the single \`::after\` outline in
   --colorStrokeFocus2, so retinting that token gives it WinUI's outer focus
   stroke. The inner ring of WinUI's two-ring composite is an inset shadow
   because it has to sit inside the outer ring's own border box, and the drawer's
   own border exists on one side only.

   Fluent puts that pseudo-element two pixels outside the drawer, and the drawer
   clips: with square corners nothing of a ring drawn outside it survives, so the
   pseudo-element is pulled onto the padding box and the pair is drawn inward.

   Forced colours are left to Fluent and the user agent.
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
   must remain a clipped layout cell; otherwise a one-pixel rounding overflow can
   expose a second native scrollbar beside the OverlayScrollbars viewport.

   Fluent's block padding on that element is added back only on an edge that is a
   first or last child, so a body following a DrawerHeader gets none and a
   control at its edge has its focus ring cut by the clip this rule installs.
   Squaring it at 25px gives the clip the same room on both ends. A production
   body passes \`!p-0\` and nests its own padded ScrollArea, so this reaches the
   plain bodies alone.
   https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-drawer/library/src/components/DrawerBody/useDrawerBodyStyles.styles.ts#L16-L31 */
.fui-DrawerBody.fui-DrawerBody {
  min-height: 0;
  overflow: hidden;
  padding-block: 25px;
}
`;
