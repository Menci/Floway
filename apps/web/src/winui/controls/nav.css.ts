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
// foreground and fill rules below name all four and siblings in one list stay
// in step. AppItem is the one of the four Fluent gives no selected state, so
// selection, its indicator and the tokens a selected item reads are stated for
// the other three; the icon tokens narrow further to the two that pair a
// selected state with an icon slot.
//
// Several rows below substitute a Fluent token rather than declare the property
// the token feeds. That is not a style choice: those values are painted from a
// keyframe stop, which outranks every normal rule in the cascade, so the
// variable that stop reads is the one place left where the colour can still be
// chosen. See ./tokens.ts for the selector convention.
export const navCss = `
/* The seam between the pane and the page. WinUI's pane draws no edge of its
   own -- PaneContentGrid names a border brush and never a thickness, and the
   split view around it is driven to PaneNotOverlaying in the expanded form,
   which sets its own border transparent. The hairline one sees at the boundary
   comes from the other side: ContentGrid carries 1,1,0,0 of
   CardStrokeColorDefault under an 8,0,0,0 corner radius over
   LayerFillColorDefault -- a card the content sits on, whose start edge runs
   down the seam. The dashboard's content region is not that card: it has no
   border, no radius and no layer fill of its own, so the seam is drawn from
   the pane's inline-end edge, which is the one side Fluent gives a border
   style to. It is retinted from the divider stroke ./drawer.css gives every
   inline drawer to the card stroke WinUI paints this particular seam with; the
   rounded start corner belongs to the content side and is not reproduced.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView.xaml#L127
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView.xaml#L290
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView.xaml#L392
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L49
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L234
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L263 */
.fui-NavDrawer.fui-InlineDrawer {
  border-inline-end-color: var(--winui-card-stroke-default);
}

/* Item foreground. Fluent's neutral pair gives way to WinUI's primary text
   fill, and the press state drops to the secondary one -- which WinUI states
   for a selected item as well, so the pressed rule reads on every item and the
   sidebar's pending row, held pressed for the length of a navigation, is
   included in it. The substitution is made on the token rather than on
   \`color\` because the icon slot's de-selection keyframe reads the same token
   for its 0% stop; declaring \`color\` alone would leave that keyframe starting
   from Fluent's grey.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L21
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L23
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L31 */
.fui-NavItem.fui-NavItem,
.fui-NavSubItem.fui-NavSubItem,
.fui-NavCategoryItem.fui-NavCategoryItem,
.fui-AppItem.fui-AppItem {
  --colorNeutralForeground2: var(--winui-text-fill-primary);
}

.fui-NavItem.fui-NavItem:active,
.fui-NavItem.fui-NavItem[data-nav-pending],
.fui-NavSubItem.fui-NavSubItem:active,
.fui-NavCategoryItem.fui-NavCategoryItem:active,
.fui-AppItem.fui-AppItem:active {
  --colorNeutralForeground2: var(--winui-text-fill-secondary);
}

/* The item fill. WinUI rests every navigation item on the transparent subtle
   fill and steps it toward the material on pointer, where Fluent steps it away
   from one. Selection is the same ramp held one step in, so a selected item and
   a hovered one read alike until the indicator distinguishes them -- which is
   why the indicator, not the fill, is what carries selection here. AppItem
   joins the list as a pane row drawn from the same template: WinUI states no
   brush of its own for it, and on Fluent's neutral background 4 it would be the
   one opaque slab in a transparent pane. It takes only the states it has, which
   are the unselected ones.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L9-L20 */
.fui-NavItem.fui-NavItem,
.fui-NavSubItem.fui-NavSubItem,
.fui-NavCategoryItem.fui-NavCategoryItem,
.fui-AppItem.fui-AppItem {
  background-color: var(--winui-subtle-fill-transparent);
}

.fui-NavItem.fui-NavItem:hover,
.fui-NavItem.fui-NavItem[aria-current='page'],
.fui-NavSubItem.fui-NavSubItem:hover,
.fui-NavSubItem.fui-NavSubItem[aria-current='page'],
.fui-NavCategoryItem.fui-NavCategoryItem:hover,
.fui-NavCategoryItem.fui-NavCategoryItem[aria-current='page'],
.fui-AppItem.fui-AppItem:hover {
  background-color: var(--winui-subtle-fill-secondary);
}

/* Selection does not change the weight. NavigationViewItem states Normal and
   states it once, for every state it has; Fluent bolds the selected label,
   which puts a second signal on a state the indicator already carries and
   shifts the label's width as it lands. The selected-label atom is the only
   place the weight is set, so naming the state is enough to undo it.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L641 */
.fui-NavItem.fui-NavItem[aria-current='page'],
.fui-NavSubItem.fui-NavSubItem[aria-current='page'],
.fui-NavCategoryItem.fui-NavCategoryItem[aria-current='page'] {
  font-weight: var(--fontWeightRegular);
}

/* Fluent draws its own selection indicator as an ::after on the selected item,
   4px wide and 20px tall and fully rounded, in the compound brand foreground.
   WinUI's is 3px wide at a 2px radius in the accent fill.

   A NavItem's is cleared outright: WinUI's indicator animates between the item
   losing selection and the one taking it, which a per-item pseudo-element
   cannot do, so the sidebar draws a measured one and this stops the two from
   both showing. A category row is never the source or the destination of that
   animation -- it opens and closes rather than navigating -- and a sub-item is
   rendered nowhere the measured indicator is drawn, so both keep a
   pseudo-element, restated at WinUI's geometry and colour.

   WinUI states the pill's length as a fixed 16px on its 36px left-pane row.
   Our choice is a proportion instead -- a quarter inset at each end -- so the
   pill keeps its proportion as the row grows rather than sitting short in a
   tall one. ./list.css.ts and ./select.css.ts state the same quarter inset.

   The colour is not a declaration but a token substitution, because Fluent
   grows the pill in with a keyframe -- \`0% { background: transparent }\` to
   \`100% { background: var(--colorCompoundBrandForeground1) }\` -- filled in
   both directions. An animation outranks every normal rule in the cascade, so
   a \`background-color\` of ours would be overridden by the 100% stop for as
   long as the item stays selected; the variable that stop reads is the only
   input left. It is declared on the pseudo-element itself so it reaches the
   one declaration that reads it and nothing the row contains.
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
.fui-NavCategoryItem.fui-NavCategoryItem[aria-current='page']:hover,
.fui-AppItem.fui-AppItem:active {
  background-color: var(--winui-subtle-fill-tertiary);
}

.fui-NavItem.fui-NavItem[aria-current='page']:active,
.fui-NavSubItem.fui-NavSubItem[aria-current='page']:active,
.fui-NavCategoryItem.fui-NavCategoryItem[aria-current='page']:active {
  background-color: var(--winui-subtle-fill-secondary);
}

/* WinUI leaves a disabled item on the transparent fill rather than dimming it,
   so the foreground below carries the whole disabled reading. A disabled item
   that is also the selected one is the exception: it keeps the standing wash
   selection puts under it, so that a pane whose current page has been disabled
   still says which page one is on. Both the native and the ARIA form are named
   because an item renders as a button or as an anchor depending on whether it
   was given an href, and each pair comes after the pointer states it has to
   settle, since a disabled element still matches :hover.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L12
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L20 */
.fui-NavItem.fui-NavItem:disabled,
.fui-NavItem.fui-NavItem[aria-disabled='true'],
.fui-NavSubItem.fui-NavSubItem:disabled,
.fui-NavSubItem.fui-NavSubItem[aria-disabled='true'],
.fui-NavCategoryItem.fui-NavCategoryItem:disabled,
.fui-NavCategoryItem.fui-NavCategoryItem[aria-disabled='true'],
.fui-AppItem.fui-AppItem:disabled,
.fui-AppItem.fui-AppItem[aria-disabled='true'] {
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

/* Fluent styles no disabled item anywhere in the nav package, so a disabled one
   reads exactly like an enabled one; WinUI dims it, and dims it to the same
   fill whether or not the item is the selected one.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L24
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L32 */
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

/* Focus. A navigation item asks for the system focus visual, which is two
   adjacent strokes: a 2px outer in FocusStrokeColorOuter and, immediately
   inside it, a 1px inner in FocusStrokeColorInner. The two are concentric with
   no gap -- the inner border is inset by exactly the outer thickness -- and
   both sit within the item's own bounds, since the focus rectangle starts as
   the element bounds shrunk by FocusVisualMargin and the item states none. The
   item itself is untouched, so its fill is the same rectangle in every state.

   Fluent draws the outer stroke only, as a real outline offset fully inside
   the border box, which is where WinUI puts it; the colour is restated on the
   token and the offset is left alone. The inner stroke has no Fluent
   counterpart to retint, so it is painted as an inset shadow three pixels
   deep, of which the outline covers the outer two -- the third pixel is the
   inner ring's place. It is a shadow rather than the two-pseudo-element
   construction used elsewhere because the item's ::after is spoken for by the
   selection indicator above. Forced colours are left to Fluent and the user
   agent: the outline colour is one they substitute and the shadow is a property
   they drop, so the visual there reduces to the system's single ring.
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
.fui-NavCategoryItem.fui-NavCategoryItem[data-fui-focus-visible],
.fui-AppItem.fui-AppItem[data-fui-focus-visible] {
  --colorStrokeFocus2: var(--winui-focus-stroke-outer);
  box-shadow:
    inset 0 0 0 var(--strokeWidthThicker) var(--winui-focus-stroke-inner);
}

/* A selected item's icon keeps the primary text fill in WinUI instead of taking
   on the brand tint Fluent gives it, and it follows the label through the rest
   of the states: WinUI states one foreground per state and the icon reads the
   same brush the label does, so pressing a selected item takes both to the
   secondary fill and disabling it takes both to the disabled one. The colour is
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

/* Section header. Fluent styles the header's type but lets its colour inherit
   from the drawer body, so it arrives at full strength; WinUI gives the header
   a brush of its own, a step quieter than the items it introduces, and states
   the type outright: NavigationViewItemHeaderTextStyle is 14 SemiBold, which is
   BodyStrong. Fluent sets caption1Strong's 12 instead, a size the WinUI ramp
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
   scrollable, which is the same condition NavigationView reveals its own pane
   separator under -- the seam is an overflow affordance in both. WinUI paints
   that separator from its divider ramp, so the card stroke ./drawer.css gives
   every drawer header and footer is retinted here; naming the pseudo-element
   restyles it without bringing it into existence.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView.xaml#L375
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView.cpp#L1585-L1626
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L46 */
.fui-NavDrawerFooter.fui-NavDrawerFooter::before {
  background-color: var(--winui-divider-stroke-default);
}
`;
