// WinUI 3 styling for Fluent v9's OverlayDrawer and InlineDrawer, which map
// onto NavigationView's overlaying and inline pane respectively.
export const drawerCss = `
/* WinUI's default text brush.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources.xaml#L14 */
.fui-OverlayDrawer.fui-OverlayDrawer,
.fui-InlineDrawer.fui-InlineDrawer {
  color: var(--winui-text-fill-primary);
}

/* AcrylicInAppFillColorDefaultBrush, flattened to its own declared fallback in
   ../tokens.ts. FlyoutPresenter carries the same brush, which is why the
   outline below is a flyout's.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView.xaml#L289
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L5
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/FlyoutPresenter_themeresources.xaml#L5 */
.fui-OverlayDrawer.fui-OverlayDrawer {
  background-color: var(--winui-acrylic-in-app-fill-default);
}

/* WinUI's inline pane is transparent; the colour the page behind it resolves to
   is named here instead, so the surface does not depend on whatever the drawer
   is placed over.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView.xaml#L129
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L6
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources.xaml#L13 */
.fui-InlineDrawer.fui-InlineDrawer {
  background-color: var(--winui-solid-background-fill-base);
}

/* An inline drawer gets no border: WinUI's expanded pane states no edge of its
   own, and the hairline at that boundary is drawn from the content side, as the
   start edge of the content card. Nothing this drawer sits beside is that card.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView.xaml#L127
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView.xaml#L392 */
.fui-InlineDrawer.fui-InlineDrawer {
  border: none;
}

/* WinUI strokes all four sides of a flyout; only the page-facing edge is
   painted here, because a viewport-anchored drawer's other three run along the
   window frame and it is the one side Fluent gives a border style to. Fluent
   blanks that same border while focus is visible to complete its focus ring, so
   the override stands aside for that state.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/FlyoutPresenter_themeresources.xaml#L6-L7 */
.fui-OverlayDrawer.fui-OverlayDrawer:not([data-fui-focus-visible]) {
  border-color: var(--winui-surface-stroke-flyout);
}

/* WinUI doubles the stroke to 2px in high contrast, where the surface fill and
   the page collapse onto the same system Window colour and the stroke is all
   that divides them. Forced colours collapse the fills the same way and leave
   widths alone, so the width is the one value restated.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/FlyoutPresenter_themeresources.xaml#L9-L12
   https://drafts.csswg.org/css-color-adjust/#forced-colors-properties */
@media (forced-colors: active) {
  .fui-OverlayDrawer.fui-OverlayDrawer {
    border-width: 2px;
  }
}

/* The inner ring of WinUI's two-ring composite has to sit inside the outer
   ring's own border box, which the drawer's one-sided border cannot provide, so
   it is an inset shadow. Fluent draws its pseudo-element two pixels outside the
   drawer, and the drawer clips with square corners, so the pseudo-element is
   pulled onto the padding box and the pair drawn inward.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L258-L259
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L251-L253 */
.fui-OverlayDrawer.fui-OverlayDrawer[data-fui-focus-visible]::after {
  inset: 0;
  box-shadow: inset 0 0 0 var(--winui-focus-visual-secondary-thickness) var(--winui-focus-stroke-inner);
}

/* SplitView's light dismiss layer stays hit-testable but is painted only in the
   OverlayVisible state, which LightDismissOverlayMode Auto -- the default --
   resolves to on Xbox alone; everywhere else the layer keeps the template's
   Transparent fill. The overlaying navigation pane opts in through this class,
   while the drawers that stand in for ContentDialog keep Fluent's dimmed
   backdrop.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/SplitView/SplitView_themeresources.xaml#L723
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/SplitView/SplitView_themeresources.xaml#L684-L693
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/components/controls/LightDismissOverlay/inc/LightDismissOverlayHelper.h#L12-L26 */
.floway-drawer-light-dismiss.floway-drawer-light-dismiss {
  background-color: transparent;
}

/* Fluent makes every DrawerBody an unconditional browser scroll owner. Bodies
   here compose around an explicit ScrollArea, so the parent must stay a clipped
   layout cell; otherwise a one-pixel rounding overflow exposes a second native
   scrollbar beside the OverlayScrollbars viewport. Fluent adds its block padding
   back only on a first or last child, so a body following a DrawerHeader gets
   none and the clip cuts the focus ring of a control at that edge; restating
   Fluent's own first-and-last term on both ends gives the clip the same room at
   each. A production body passes !p-0 and nests its own padded ScrollArea, so
   this reaches the plain bodies alone.
   https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-drawer/library/src/components/DrawerBody/useDrawerBodyStyles.styles.ts#L16-L31 */
.fui-DrawerBody.fui-DrawerBody {
  min-height: 0;
  overflow: hidden;
  padding-block: calc(var(--spacingHorizontalXXL) + 1px);
}
`;
