// WinUI 3 menu-flyout styling for Fluent v9's Menu family. Fluent paints a menu
// item as an opaque neutral card that deepens on hover and press, with the icon
// turning brand on hover; WinUI paints it as a transparent strip that picks up a
// translucent subtle fill, lighter on press than on hover, and keeps one text
// brush across every state. The one slot held back from that invariant is
// `__subText`, which the corpus gives no counterpart: outside the disabled
// state it keeps Fluent's own foreground ramp and still shifts on hover.
//
// WinUI ships no MenuFlyoutPresenter dictionary. The surface is the
// FlyoutPresenter style the presenter derives from, and the item's state fills
// are the ListViewItem set — the mapping fluent-svelte's MenuFlyoutItem
// independently arrives at.
//
// Every rule is scoped under `.fui-FluentProvider`, the element that carries
// both Fluent's tokens and the `--winui-*` vocabulary, which puts each selector
// at least one class above Griffel's single-class atoms.
//
// Menu and MenuTrigger render no element of their own, and MenuList declares
// only layout, so neither appears below.
//
// MenuItemCheckbox, MenuItemRadio, MenuItemSwitch and MenuItemLink each add a
// root class of their own and then run the MenuItem style hook, so every item
// rule below reaches all five roots and their shared slot classes. The
// `__checkmark` and `__submenuIndicator` slots declare geometry only and take
// the item's foreground by inheritance.
export const menuCss = `
/* Flyout surface. WinUI rounds a flyout further than a control and outlines it
   with the dedicated flyout stroke.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CornerRadius_themeresources.xaml#L6
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/FlyoutPresenter_themeresources.xaml#L6

   Only the block term of WinUI's menu-flyout padding is transcribed. Its inline
   term is 0 because a NavigationView child flyout's items carry their own
   inline inset, which the corpus does not state for a plain menu item, so
   Fluent's inline padding is what keeps items off the surface edge.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L267 */
.fui-FluentProvider .fui-MenuPopover {
  border-radius: var(--winui-overlay-corner-radius);
  border-color: var(--winui-surface-stroke-flyout);
  padding-block: 2px;
}

/* Item at rest. Fluent gives the item its own opaque fill; WinUI leaves it
   transparent so the flyout surface shows through, and states one foreground
   brush that every later state reuses.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L17
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L23 */
.fui-FluentProvider .fui-MenuItem {
  background-color: var(--winui-subtle-fill-transparent);
  color: var(--winui-text-fill-primary);
}

/* The trailing hint reads as secondary text, as fluent-svelte's MenuFlyoutItem
   also has it. Fluent moves the hint on its own :hover and :focus, so the item
   root is named as well to clear those two rules by a class.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L89 */
.fui-FluentProvider .fui-MenuItem .fui-MenuItem__secondaryContent {
  color: var(--winui-text-fill-secondary);
}

/* Because WinUI paints the item with a single foreground brush, the icon takes
   the item's own colour instead of turning brand — which Fluent does both on
   hover and while a submenu is open. Inheriting covers the disabled item too,
   whose own brush is already the disabled one.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L24 */
.fui-FluentProvider .fui-MenuItem:hover .fui-MenuItem__icon,
.fui-FluentProvider .fui-MenuItem[aria-expanded="true"] .fui-MenuItem__icon {
  color: inherit;
}

/* Hover and press. WinUI moves the fill along the subtle ramp — transparent to
   secondary to tertiary — where Fluent walks the neutral-background ramp, and
   tertiary is the lighter of the two, so the item lifts on press rather than
   deepening. The foreground brush does not move in either state.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L18
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L24 */
.fui-FluentProvider .fui-MenuItem:hover {
  background-color: var(--winui-subtle-fill-secondary);
  color: var(--winui-text-fill-primary);
}

/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L19
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L25 */
.fui-FluentProvider .fui-MenuItem:hover:active {
  background-color: var(--winui-subtle-fill-tertiary);
  color: var(--winui-text-fill-primary);
}

/* Submenu open. A submenu trigger is held in the pointer-over fill for as long
   as its flyout is up, so the state resolves to the same brush as hover. The
   hook is the aria-expanded attribute MenuTrigger renders unconditionally on a
   submenu child; the rest rule would otherwise strip Fluent's own open fill and
   leave the trigger flat. Only the fill is stated — the rest rule already
   outranks Fluent's single-atom open foreground.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L18 */
.fui-FluentProvider .fui-MenuItem[aria-expanded="true"] {
  background-color: var(--winui-subtle-fill-secondary);
}

/* Disabled. Fluent holds its opaque rest fill under the pointer; WinUI holds a
   transparent one. The foreground is left to Fluent, whose disabled brush the
   theme already remaps onto the WinUI one.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L17 */
.fui-FluentProvider .fui-MenuItem[aria-disabled="true"],
.fui-FluentProvider .fui-MenuItem[aria-disabled="true"]:hover,
.fui-FluentProvider .fui-MenuItem[aria-disabled="true"]:hover:active {
  background-color: var(--winui-subtle-fill-transparent);
}

/* The hint and the sub-text follow the item into the disabled brush; each is
   matched one class deeper than the rule that paints it at rest, so the
   hovered forms need no selector of their own.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L91 */
.fui-FluentProvider .fui-MenuItem[aria-disabled="true"] .fui-MenuItem__secondaryContent,
.fui-FluentProvider .fui-MenuItem[aria-disabled="true"] .fui-MenuItem__subText {
  color: var(--winui-text-fill-disabled);
}

/* Focus. Fluent draws one ring on a pseudo-element; WinUI draws two concentric
   ones. The token Fluent's border reads is re-pointed on the pseudo-element
   itself, where that border resolves it, so the outer stroke lands without the
   substitution reaching any other descendant of the focused item. An inset
   shadow on the same pseudo-element — clipped to its padding box, so it sits
   immediately inside the 2px border — supplies the inner one.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L29
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L30 */
.fui-FluentProvider .fui-MenuItem[data-fui-focus-visible]::after {
  --colorStrokeFocus2: var(--winui-focus-stroke-outer);
  box-shadow: inset 0 0 0 1px var(--winui-focus-stroke-inner);
}

/* Separator. WinUI has a stroke ramp of its own for dividers rather than
   borrowing a neutral control stroke.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L143 */
.fui-FluentProvider .fui-MenuDivider {
  border-bottom-color: var(--winui-divider-stroke-default);
}
`;
