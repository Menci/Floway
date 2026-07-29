// WinUI 3 styling for Fluent v9's Drawer family — both the OverlayDrawer and
// the InlineDrawer the sidebar's NavDrawer renders, plus the header and footer
// separators the two flavours share. WinUI ships no drawer, so the surface is
// composed from the two WinUI surfaces it is made of: the outline is a
// flyout's, and the fill, foreground and scroll separator are a ContentDialog's
// — that being the WinUI surface that likewise carries a title block over
// scrolling content.
//
// FlyoutPresenter fills itself with AcrylicInAppFillColorDefaultBrush, which no
// theme dictionary resolves to a literal, so ContentDialogBackground's solid
// base is the fill we transcribe.
//
// Every rule is scoped under `.fui-FluentProvider`, the element that carries
// both Fluent's tokens and the `--winui-*` vocabulary, which puts each selector
// at least one class above Griffel's single-class atoms.
//
// That ancestor is reached even though an OverlayDrawer portals to
// `document.body`. FluentProvider publishes `applyStylesToPortals` (default
// true), under which its ThemeClassName context carries the provider root's
// whole className — which begins with the literal `fui-FluentProvider` — rather
// than only the per-instance `fui-FluentProviderN` style-tag id. The portal
// mount node merges that string onto itself, so it is both an ancestor matching
// these selectors and the element on which tokens.ts declares the `--winui-*`
// custom properties that the drawer inherits.
export const drawerCss = `
/* Surface fill and foreground, taken from the ContentDialog keys rather than
   Fluent's neutral background and foreground pair. Both flavours share the pair
   through the same shared default styles, so both are named here; letting only
   the overlay move would leave the sidebar's inline drawer Fluent-white beside
   it.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ContentDialog_themeresources.xaml#L39-L40 */
.fui-FluentProvider .fui-OverlayDrawer,
.fui-FluentProvider .fui-InlineDrawer {
  background-color: var(--winui-solid-background-fill-base);
  color: var(--winui-text-fill-primary);
}

/* An inline drawer's optional separator is the hairline between two regions of
   one page, which WinUI paints with the divider stroke; Fluent reaches for a
   neutral fill instead. Fluent gives the border a style on the one side facing
   the content, so this shorthand lands only there.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L257 */
.fui-FluentProvider .fui-InlineDrawer {
  border-color: var(--winui-divider-stroke-default);
}

/* The edge facing the page is a flyout border. Fluent gives a border style to
   that one side only — the right edge for a start drawer, the left for an end
   one, none at all for a bottom one — so this shorthand reaches exactly the
   edge Fluent paints and the style-less sides stay unpainted. While focus is
   visible Fluent blanks the same border to complete its focus ring, so the
   override stands aside for that state.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/FlyoutPresenter_themeresources.xaml#L16 */
.fui-FluentProvider .fui-OverlayDrawer:not([data-fui-focus-visible]) {
  border-color: var(--winui-surface-stroke-flyout);
}

/* Fluent's drawer focus ring is the single \`::after\` outline in
   --colorStrokeFocus2, so retinting that token gives it WinUI's outer focus
   stroke. WinUI's visual is a two-ring composite, and the inner ring is an
   inset shadow because it has to sit inside the outer ring's own border box —
   the drawer's own border exists on one side only, so it cannot carry it. The
   two thicknesses are the framework defaults, which this corpus states only
   where ListViewItem restates them.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L258-L259
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L250-L252 */
.fui-FluentProvider .fui-OverlayDrawer[data-fui-focus-visible] {
  --colorStrokeFocus2: var(--winui-focus-stroke-outer);
}

.fui-FluentProvider .fui-OverlayDrawer[data-fui-focus-visible]::after {
  box-shadow: inset 0 0 0 1px var(--winui-focus-stroke-inner);
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
.fui-FluentProvider .fui-DrawerHeader::after,
.fui-FluentProvider .fui-DrawerFooter::before {
  background-color: var(--winui-card-stroke-default);
  transition-duration: var(--winui-control-normal-animation-duration);
  transition-timing-function: var(--winui-control-fast-out-slow-in-easing);
}
`;
