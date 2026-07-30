// WinUI 3 styling for Fluent v9's Nav family — the drawer's footer separator,
// the section headers, and the items themselves. WinUI's counterpart is
// NavigationView in its left-pane form, whose item is the whole of the visual:
// a transparent body over a subtle fill ramp, a text foreground that only moves
// on press, and an accent pill marking the selected one.
//
// The drawer shell around these — fill, outline, header and footer geometry —
// belongs to ./drawer.css, which the sidebar's inline NavDrawer already picks
// up through its InlineDrawer class.
//
// NavItem, NavSubItem, NavCategoryItem and AppItem all render Fluent's one
// shared root reset (sharedNavStyles.styles: useRootDefaultClassName), so the
// foreground rules below name all four and siblings in one list stay in step.
// The tokens that only a selected item reads are narrowed to the two that can
// be selected and carry an icon.
//
// Several rows below substitute a Fluent token rather than declare the property
// the token feeds. That is not a style choice: the values are reached only
// through a keyframe stop or through a declaration the sidebar marks
// `!important`, and in both cases the variable is the one place left where the
// colour can still be chosen. See ./tokens.ts for the selector convention.
export const navCss = `
/* Item foreground. Fluent's neutral pair gives way to WinUI's primary text
   fill, and the press state drops to the secondary one. The substitution is
   made on the token rather than on \`color\` because the icon slot's
   de-selection keyframe reads the same token for its 0% stop; declaring
   \`color\` alone would leave that keyframe starting from Fluent's grey.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L21
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L23 */
.fui-NavItem.fui-NavItem,
.fui-NavSubItem.fui-NavSubItem,
.fui-NavCategoryItem.fui-NavCategoryItem,
.fui-AppItem.fui-AppItem {
  --colorNeutralForeground2: var(--winui-text-fill-primary);
}

.fui-NavItem.fui-NavItem:active,
.fui-NavSubItem.fui-NavSubItem:active,
.fui-NavCategoryItem.fui-NavCategoryItem:active,
.fui-AppItem.fui-AppItem:active {
  --colorNeutralForeground2: var(--winui-text-fill-secondary);
}

/* The item fill. WinUI rests every navigation item on the transparent subtle
   fill and steps it toward the material on pointer, where Fluent steps it away
   from one. Selection is the same ramp held one step in, so a selected item and
   a hovered one read alike until the indicator distinguishes them -- which is
   why the indicator, not the fill, is what carries selection here.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L26-L32 */
.fui-NavItem.fui-NavItem {
  background-color: var(--winui-subtle-fill-transparent);
}

.fui-NavItem.fui-NavItem:hover,
.fui-NavItem.fui-NavItem[aria-current='page'] {
  background-color: var(--winui-subtle-fill-secondary);
}

/* Fluent draws its own selection indicator as an ::after on the selected item,
   4px wide and 20px tall in the compound brand foreground. WinUI's is 3px by
   16px in the accent fill, and it animates between the item losing selection
   and the one taking it, which a per-item pseudo-element cannot do. The
   sidebar draws that one; this clears Fluent's so the two do not both show.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L220-L222 */
.fui-NavItem.fui-NavItem::after {
  content: none;
}

.fui-NavItem.fui-NavItem:active,
.fui-NavItem.fui-NavItem[data-nav-pending],
.fui-NavItem.fui-NavItem[aria-current='page']:hover {
  background-color: var(--winui-subtle-fill-tertiary);
}

.fui-NavItem.fui-NavItem[aria-current='page']:active {
  background-color: var(--winui-subtle-fill-secondary);
}

/* WinUI leaves a disabled item on the transparent fill rather than dimming it,
   so the foreground above carries the whole disabled reading.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L33 */
.fui-NavItem.fui-NavItem:disabled,
.fui-NavItem.fui-NavItem[aria-disabled='true'] {
  background-color: var(--winui-subtle-fill-transparent);
}

/* Fluent styles no disabled item anywhere in the nav package, so a disabled one
   reads exactly like an enabled one; WinUI dims it. Both the native and the
   ARIA form are named because an item renders as a button or as an anchor
   depending on whether it was given an href.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L24 */
.fui-NavItem.fui-NavItem:disabled,
.fui-NavItem.fui-NavItem[aria-disabled='true'],
.fui-NavSubItem.fui-NavSubItem:disabled,
.fui-NavSubItem.fui-NavSubItem[aria-disabled='true'],
.fui-NavCategoryItem.fui-NavCategoryItem:disabled,
.fui-NavCategoryItem.fui-NavCategoryItem[aria-disabled='true'],
.fui-AppItem.fui-AppItem:disabled,
.fui-AppItem.fui-AppItem[aria-disabled='true'] {
  --colorNeutralForeground2: var(--winui-text-fill-disabled);
}

/* Focus. WinUI's focus visual on a navigation item is one ring: the outer
   stroke, two pixels thick, sitting a pixel beyond the item with nothing drawn
   in between. The gap is transparent, not filled -- what shows through it is
   whatever the item sits on, which on Windows is the pane's material. The item
   itself is untouched, so its fill is the same rectangle in every state.

   FocusStrokeColorInner is not a second ring here. It belongs to controls that
   draw a stroke against their own body, which a navigation item has none of;
   painting it as one is what puts a pale edge on the fill.

   Fluent draws the same ring but pulls it inward, so only the offset and the
   colour are restated.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L258-L259 */
.fui-NavItem.fui-NavItem[data-fui-focus-visible],
.fui-NavSubItem.fui-NavSubItem[data-fui-focus-visible],
.fui-NavCategoryItem.fui-NavCategoryItem[data-fui-focus-visible],
.fui-AppItem.fui-AppItem[data-fui-focus-visible] {
  --colorStrokeFocus2: var(--winui-focus-stroke-outer);
  outline-offset: 1px;
}

/* A selected item's icon keeps the primary text fill in WinUI instead of taking
   on the brand tint Fluent gives it. The colour is reached only through the
   100% stop of the icon slot's selection keyframe, so the token is again the
   one place it can be chosen. Only the two families that pair a selected state
   with an icon read it.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L29 */
.fui-NavItem.fui-NavItem,
.fui-NavCategoryItem.fui-NavCategoryItem {
  --colorNeutralForeground2BrandSelected: var(--winui-text-fill-primary);
}

/* Two divergences from WinUI survive on the selected item, both for want of a
   value we are willing to state here.
   The selection pill keeps the fill the sidebar gives it. WinUI paints the
   indicator with AccentFillColorDefault, which in the dark theme steps to a
   LIGHTER accent (SystemAccentColorLight2) than the light theme's; our accent
   ramp is derived from Fluent's brand background, which steps darker there, so
   pointing the pill at it would move the dark indicator away from WinUI while
   changing nothing in light.
   Fluent also switches the selected label to semibold, where no NavigationView
   visual state touches the weight at all and the one item style that states it
   states Normal. Correcting that needs a type ramp, and ./tokens.ts is a
   colour vocabulary.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L48
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L641 */

/* Section header. Fluent styles the header's type but lets its colour inherit
   from the drawer body, so it arrives at full strength; WinUI gives the header
   a brush of its own, a step quieter than the items it introduces. Its size
   parts from WinUI too — Fluent sets caption1Strong's 12px against
   NavigationViewItemHeaderTextStyle's 14px — and stays as it is for the same
   reason the selected weight does.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L47
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L1082 */
.fui-NavSectionHeader.fui-NavSectionHeader {
  color: var(--winui-text-fill-secondary);
}

/* The rule separating the footer from the scrolling item list is a nav
   separator, which WinUI paints from its divider ramp rather than from a
   neutral control stroke. The sidebar sets that colour inline through Fluent's
   token, so the token is where the value is chosen.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L46 */
.fui-NavDrawerFooter.fui-NavDrawerFooter {
  --colorNeutralStroke2: var(--winui-divider-stroke-default);
}

/* The item's body fill is out of reach. WinUI runs it through the subtle ramp —
   transparent at rest, SubtleFillColorSecondary under the pointer,
   SubtleFillColorTertiary while pressed, and secondary again once selected —
   but the sidebar declares each of those states \`!important\` with a literal
   brand-tinted color-mix, leaving no token to re-point and no specificity above
   it. Bringing the item onto the WinUI ramp is a change to that component, not
   to this layer.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L9-L11
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L17 */
`;
