// WinUI 3 styling for Fluent v9's Nav family. The drawer shell around these --
// fill, outline, header and footer geometry -- belongs to ./drawer.css.
//
// NavItem, NavSubItem and NavCategoryItem all render Fluent's one shared root
// reset (sharedNavStyles.styles: useRootDefaultClassName), so the foreground
// and fill rules below name all three and siblings stay in step.
//
// Several rows below substitute a Fluent token rather than declare the property
// the token feeds. Those values are painted from a keyframe stop, which
// outranks every normal rule in the cascade, so the variable that stop reads is
// the one place left where the colour can still be chosen. See ./tokens.ts for
// the selector convention.
export const navCss = `
/* The pane's inline-end edge carries no seam. WinUI's hairline at this boundary
   is drawn by the content side -- ContentGrid is a card and the seam is that
   card's start edge. The dashboard's content region is not a card, so there is
   no edge for the seam to belong to, and drawing one on the pane instead would
   be inventing a boundary WinUI states nowhere.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView.xaml#L290
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L234 */
.fui-NavDrawer.fui-InlineDrawer {
  border-inline-end-style: none;
}

/* Item foreground. The press state drops to the secondary fill, which WinUI
   states for a selected item as well, so the sidebar's pending row -- held
   pressed for the length of a navigation -- is included in it. The substitution
   is made on the token rather than on \`color\` because the icon slot's
   de-selection keyframe reads the same token for its 0% stop; declaring
   \`color\` alone would leave that keyframe starting from Fluent's grey.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L21
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L23
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L31 */
.fui-NavItem.fui-NavItem,
.fui-NavSubItem.fui-NavSubItem,
.fui-NavCategoryItem.fui-NavCategoryItem {
  --colorNeutralForeground2: var(--winui-text-fill-primary);
}

.fui-NavItem.fui-NavItem:active,
.fui-NavItem.fui-NavItem[data-nav-pending],
.fui-NavSubItem.fui-NavSubItem:active,
.fui-NavCategoryItem.fui-NavCategoryItem:active {
  --colorNeutralForeground2: var(--winui-text-fill-secondary);
}

/* The item fill. Selection is the same ramp held one step in, so a selected
   item and a hovered one read alike -- which is why the indicator, not the
   fill, is what carries selection here.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L9-L20 */
.fui-NavItem.fui-NavItem,
.fui-NavSubItem.fui-NavSubItem,
.fui-NavCategoryItem.fui-NavCategoryItem {
  background-color: var(--winui-subtle-fill-transparent);
}

.fui-NavItem.fui-NavItem:hover,
.fui-NavItem.fui-NavItem[aria-current='page'],
.fui-NavSubItem.fui-NavSubItem:hover,
.fui-NavSubItem.fui-NavSubItem[aria-current='page'],
.fui-NavCategoryItem.fui-NavCategoryItem:hover,
.fui-NavCategoryItem.fui-NavCategoryItem[aria-current='page'] {
  background-color: var(--winui-subtle-fill-secondary);
}

/* Selection does not change the weight. NavigationViewItem states Normal for
   every state it has; Fluent bolds the selected label, which puts a second
   signal on a state the indicator already carries and shifts the label's width
   as it lands.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L641 */
.fui-NavItem.fui-NavItem[aria-current='page'],
.fui-NavSubItem.fui-NavSubItem[aria-current='page'],
.fui-NavCategoryItem.fui-NavCategoryItem[aria-current='page'] {
  font-weight: var(--fontWeightRegular);
}

/* A NavItem's own indicator is cleared outright: WinUI's animates between the
   item losing selection and the one taking it, which a per-item
   pseudo-element cannot do, so the sidebar draws a measured one and this stops
   the two from both showing. A category row is never the source or destination
   of that animation and a sub-item is rendered nowhere the measured indicator
   is drawn, so both keep a pseudo-element at WinUI's geometry and colour.

   WinUI states the pill's length as a fixed 16px on its 36px left-pane row.
   The quarter inset at each end reproduces that at the stock row height while
   holding the pill's proportion as the row grows, rather than leaving it short
   in a tall one; the sidebar's own measured indicator is pinned at 20px to
   match.

   The colour is a token substitution rather than a declaration, because Fluent
   grows the pill in with a keyframe filled in both directions. An animation
   outranks every normal rule, so a \`background-color\` of ours would be
   overridden by the 100% stop for as long as the item stays selected; the
   variable that stop reads is the only input left.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L217
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L220-L222
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L48 */
.fui-NavItem.fui-NavItem::after {
  content: none;
}

.fui-NavSubItem.fui-NavSubItem[aria-current='page']::after,
.fui-NavCategoryItem.fui-NavCategoryItem[aria-current='page']::after {
  --colorCompoundBrandForeground1: var(--winui-accent-fill-default);
  border-radius: 2px;
  height: auto;
  inset-block: 25%;
  width: 3px;
}

.fui-NavItem.fui-NavItem:active,
.fui-NavItem.fui-NavItem[data-nav-pending],
.fui-NavItem.fui-NavItem[aria-current='page']:hover,
.fui-NavSubItem.fui-NavSubItem:active,
.fui-NavSubItem.fui-NavSubItem[aria-current='page']:hover,
.fui-NavCategoryItem.fui-NavCategoryItem:active,
.fui-NavCategoryItem.fui-NavCategoryItem[aria-current='page']:hover {
  background-color: var(--winui-subtle-fill-tertiary);
}

.fui-NavItem.fui-NavItem[aria-current='page']:active,
.fui-NavSubItem.fui-NavSubItem[aria-current='page']:active,
.fui-NavCategoryItem.fui-NavCategoryItem[aria-current='page']:active {
  background-color: var(--winui-subtle-fill-secondary);
}

/* WinUI leaves a disabled item on the transparent fill rather than dimming it,
   so the foreground below carries the whole disabled reading. A disabled item
   that is also the selected one keeps the standing wash selection puts under
   it, so a pane whose current page has been disabled still says which page one
   is on. Both the native and the ARIA form are named because an item renders
   as a button or as an anchor depending on whether it was given an href, and
   each pair must come after the pointer states it has to settle, since a
   disabled element still matches :hover.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L12
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L20 */
.fui-NavItem.fui-NavItem:disabled,
.fui-NavItem.fui-NavItem[aria-disabled='true'],
.fui-NavSubItem.fui-NavSubItem:disabled,
.fui-NavSubItem.fui-NavSubItem[aria-disabled='true'],
.fui-NavCategoryItem.fui-NavCategoryItem:disabled,
.fui-NavCategoryItem.fui-NavCategoryItem[aria-disabled='true'] {
  background-color: var(--winui-subtle-fill-transparent);
}

.fui-NavItem.fui-NavItem[aria-current='page']:disabled,
.fui-NavItem.fui-NavItem[aria-current='page'][aria-disabled='true'],
.fui-NavSubItem.fui-NavSubItem[aria-current='page']:disabled,
.fui-NavSubItem.fui-NavSubItem[aria-current='page'][aria-disabled='true'],
.fui-NavCategoryItem.fui-NavCategoryItem[aria-current='page']:disabled,
.fui-NavCategoryItem.fui-NavCategoryItem[aria-current='page'][aria-disabled='true'] {
  background-color: var(--winui-subtle-fill-secondary);
}

/* Fluent styles no disabled item anywhere in the nav package, so WinUI's dim
   is stated here; it is the same fill whether or not the item is selected.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L24
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L32 */
.fui-NavItem.fui-NavItem:disabled,
.fui-NavItem.fui-NavItem[aria-disabled='true'],
.fui-NavSubItem.fui-NavSubItem:disabled,
.fui-NavSubItem.fui-NavSubItem[aria-disabled='true'],
.fui-NavCategoryItem.fui-NavCategoryItem:disabled,
.fui-NavCategoryItem.fui-NavCategoryItem[aria-disabled='true'] {
  --colorNeutralForeground2: var(--winui-text-fill-disabled);
}

/* Focus. WinUI's system focus visual is two concentric strokes with no gap: a
   2px outer and a 1px inner inset by exactly the outer thickness, both within
   the item's own bounds.

   Fluent draws the outer stroke only, as an outline offset fully inside the
   border box, so the colour is restated on the token and the offset left
   alone. The inner stroke is painted as an inset shadow three pixels deep, of
   which the outline covers the outer two -- a shadow rather than the
   two-pseudo-element construction used elsewhere, because the item's ::after is
   spoken for by the selection indicator above. Forced colours are left to
   Fluent and the user agent: the outline colour is one they substitute and the
   shadow is a property they drop.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView.xaml#L429
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources.xaml#L15-L16
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L258-L259
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L250-L252
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/components/FocusRect/FocusRectManager.cpp#L173-L174
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/components/FocusRect/FocusRectManager.cpp#L446-L452
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/components/FocusRect/inc/FocusRectNudging.h#L388
   https://drafts.csswg.org/css-color-adjust/#forced-colors-properties */
.fui-NavItem.fui-NavItem[data-fui-focus-visible],
.fui-NavSubItem.fui-NavSubItem[data-fui-focus-visible],
.fui-NavCategoryItem.fui-NavCategoryItem[data-fui-focus-visible] {
  --colorStrokeFocus2: var(--winui-focus-stroke-outer);
  box-shadow:
    inset 0 0 0 var(--strokeWidthThicker) var(--winui-focus-stroke-inner);
}

/* A selected item's icon keeps the primary text fill instead of Fluent's brand
   tint, and follows the label through the remaining states. The colour is
   reached only through the 100% stop of the icon slot's selection keyframe, and
   a keyframe outranks every normal rule, so the token is the one place each of
   those states can be chosen -- without them the icon of a selected item would
   sit at full strength while its label moved. Only the two families that pair a
   selected state with an icon read it.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L29
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L31
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L32 */
.fui-NavItem.fui-NavItem,
.fui-NavCategoryItem.fui-NavCategoryItem {
  --colorNeutralForeground2BrandSelected: var(--winui-text-fill-primary);
}

.fui-NavItem.fui-NavItem:active,
.fui-NavItem.fui-NavItem[data-nav-pending],
.fui-NavCategoryItem.fui-NavCategoryItem:active {
  --colorNeutralForeground2BrandSelected: var(--winui-text-fill-secondary);
}

.fui-NavItem.fui-NavItem:disabled,
.fui-NavItem.fui-NavItem[aria-disabled='true'],
.fui-NavCategoryItem.fui-NavCategoryItem:disabled,
.fui-NavCategoryItem.fui-NavCategoryItem[aria-disabled='true'] {
  --colorNeutralForeground2BrandSelected: var(--winui-text-fill-disabled);
}

/* Section header. NavigationViewItemHeaderTextStyle is 14 SemiBold, which is
   BodyStrong; Fluent sets caption1Strong's 12 instead, a size the WinUI ramp
   pairs with the regular weight and never with a strong one.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L47
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L1081-L1083 */
.fui-NavSectionHeader.fui-NavSectionHeader {
  color: var(--winui-text-fill-secondary);
  font-size: var(--fontSizeBase300);
  line-height: var(--lineHeightBase300);
}

/* The hairline separating the footer from the scrolling item list. Fluent
   generates it as a ::before on the footer, and only while the drawer body is
   scrollable -- the same condition NavigationView reveals its own pane
   separator under. Naming the pseudo-element retints the card stroke
   ./drawer.css gives every drawer footer without bringing the seam into
   existence.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView.xaml#L375
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView.cpp#L1585-L1626
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L46 */
.fui-NavDrawerFooter.fui-NavDrawerFooter::before {
  background-color: var(--winui-divider-stroke-default);
}
`;
