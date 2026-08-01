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

   The presenter's Border is BackgroundSizing="InnerBorderEdge", which is
   background-clip: padding-box on the web: the fill stops at the border so the
   translucent stroke reads against whatever the flyout floats over.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/FlyoutPresenter_themeresources.xaml#L43

   Only the block term of WinUI's menu-flyout padding is transcribed. Its inline
   term is 0 because a NavigationView child flyout's items carry their own
   inline inset, which the corpus does not state for a plain menu item, so
   Fluent's inline padding is what keeps items off the surface edge.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L267 */
.fui-MenuPopover.fui-MenuPopover {
  background-clip: padding-box;
  background-color: var(--winui-acrylic-in-app-fill-default);
  border-radius: var(--winui-overlay-corner-radius);
  border-color: var(--winui-surface-stroke-flyout);
  padding-block: 2px;
}

/* Item at rest. Fluent gives the item its own opaque fill; WinUI leaves it
   transparent so the flyout surface shows through, and states one foreground
   brush that every later state reuses.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L17
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L23 */
.fui-MenuItem.fui-MenuItem {
  background-color: var(--winui-subtle-fill-transparent);
  color: var(--winui-text-fill-primary);
}

/* The trailing hint reads as secondary text, as fluent-svelte's MenuFlyoutItem
   also has it. Fluent moves the hint on its own :hover and :focus, so the item
   root is named as well to clear those two rules by a class.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L89 */
.fui-MenuItem .fui-MenuItem__secondaryContent.fui-MenuItem__secondaryContent {
  color: var(--winui-text-fill-secondary);
}

/* Because WinUI paints the item with a single foreground brush, the icon takes
   the item's own colour instead of turning brand — which Fluent does both on
   hover and while a submenu is open. Inheriting covers the disabled item too,
   whose own brush is already the disabled one.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L24 */
.fui-MenuItem:hover .fui-MenuItem__icon.fui-MenuItem__icon,
.fui-MenuItem[aria-expanded='true'] .fui-MenuItem__icon.fui-MenuItem__icon {
  color: inherit;
}

/* Hover and press. WinUI moves the fill along the subtle ramp — transparent to
   secondary to tertiary — where Fluent walks the neutral-background ramp, and
   tertiary is the lighter of the two, so the item lifts on press rather than
   deepening. The foreground brush does not move in either state.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L18
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L24 */
.fui-MenuItem.fui-MenuItem:hover {
  background-color: var(--winui-subtle-fill-secondary);
  color: var(--winui-text-fill-primary);
}

/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L19
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L25 */
.fui-MenuItem.fui-MenuItem:hover:active {
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
.fui-MenuItem.fui-MenuItem[aria-expanded='true'] {
  background-color: var(--winui-subtle-fill-secondary);
}

/* Disabled. Fluent holds its opaque rest fill under the pointer; WinUI holds a
   transparent one. The foreground is left to Fluent, whose disabled brush the
   theme already remaps onto the WinUI one.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L17 */
.fui-MenuItem.fui-MenuItem[aria-disabled='true'],
.fui-MenuItem.fui-MenuItem[aria-disabled='true']:hover,
.fui-MenuItem.fui-MenuItem[aria-disabled='true']:hover:active {
  background-color: var(--winui-subtle-fill-transparent);
}

/* The hint and the sub-text follow the item into the disabled brush; each is
   matched one class deeper than the rule that paints it at rest, so the
   hovered forms need no selector of their own.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L91 */
.fui-MenuItem[aria-disabled='true'] .fui-MenuItem__secondaryContent.fui-MenuItem__secondaryContent,
.fui-MenuItem[aria-disabled='true'] .fui-MenuItem__subText.fui-MenuItem__subText {
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
.fui-MenuItem.fui-MenuItem[data-fui-focus-visible]::after {
  --colorStrokeFocus2: var(--winui-focus-stroke-outer);
  box-shadow: inset 0 0 0 1px var(--winui-focus-stroke-inner);
}

/* Separator. WinUI has a stroke ramp of its own for dividers rather than
   borrowing a neutral control stroke.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L143 */
.fui-MenuDivider.fui-MenuDivider {
  border-bottom-color: var(--winui-divider-stroke-default);
}

/* MenuFlyout's open. WinUI reveals a menu rather than moving it: the presenter
   slides in from half its own height while a clip slides the other way by
   exactly as much, which pins the visible window to the final layout box and
   lets only the content travel through it. A menu below its trigger starts as
   its own bottom half drawn in the top half of the box and grows downward; one
   above starts as its top half in the bottom half and grows upward. Nothing
   fades in. 250ms on the fast-out-slow-in spline.

   This lives here rather than in ../presence.ts because the direction cannot be
   read when a presence factory runs. createPresenceComponent calls the factory
   synchronously inside a layout effect, and Fluent's positioning writes
   data-popper-placement a few milliseconds later, so an element.getAttribute
   there is always null -- every menu took the downward branch, including the
   ones that flipped. CSS re-resolves when the attribute lands, which is before
   the first frame is painted, and the animation is gated on the attribute
   existing at all so an unplaced surface does not animate the wrong way and
   then correct itself. That gate is what Radix puts on its own popper content,
   for the same reason.

   The direction is carried by custom properties inside one set of keyframes
   rather than by two animation names: swapping animation-name once the
   attribute lands restarts the animation from zero, where swapping a custom
   property leaves it running and recomputes. Fluent reached the same conclusion
   and deprecated its own attribute-keyed helper for it.

   The slide is written to translate rather than into transform, because
   transform is where Fluent's positioning already lives: a surface is placed
   by translating it to the coordinates the positioning engine computed, and a
   keyframe naming transform would replace that outright and play the reveal
   at the origin of the containing block.

   Only the three edges that do not travel go outside the box. Beyond the
   travelling edge lies the element's own translated body, which a clip cannot
   tell from shadow, so a negative value there lets the surface overshoot its
   final position mid-reveal. 32px is headroom over what shadow16 needs: a blur
   spreads a shadow by about its own length past the offset edge, so its key
   term, 0 8px 16px, reaches about 24px below the border box and 16px to either
   side, and its ambient term about 2px all round.

   The close is not here. It is a bare 83ms fade with no transform, and it has
   to hold the surface mounted while it runs, which only a presence component
   can do -- ../presence.ts keeps it.

   The submenu's deeper 0.67 ratio is still not reproduced. Fluent renders a
   submenu through the same components as a menu and writes nothing that tells
   them apart.
   https://github.com/microsoft/microsoft-ui-xaml/blob/543310634592831f8f2638301ece05d2d2dbea39/src/dxaml/xcp/dxaml/lib/MenuPopupThemeTransition_Partial.h#L24-L25
   https://github.com/microsoft/microsoft-ui-xaml/blob/543310634592831f8f2638301ece05d2d2dbea39/src/dxaml/xcp/dxaml/lib/LayoutTransition_partial.cpp#L423-L563
   https://www.w3.org/TR/css-backgrounds-3/#shadow-blur
   https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/tokens/src/utils/shadows.ts */
@keyframes winui-menu-flyout-reveal {
  from {
    translate: 0 var(--winui-menu-reveal-offset);
    clip-path: inset(
      var(--winui-menu-reveal-leading) -32px var(--winui-menu-reveal-trailing) -32px);
  }
  to {
    translate: 0 0;
    clip-path: inset(
      var(--winui-menu-open-leading) -32px var(--winui-menu-open-trailing) -32px);
  }
}

.fui-MenuPopover.fui-MenuPopover {
  --winui-menu-reveal-offset: -50%;
  --winui-menu-reveal-leading: 50%;
  --winui-menu-reveal-trailing: -32px;
  --winui-menu-open-leading: 0%;
  --winui-menu-open-trailing: -32px;
  animation-duration: var(--winui-control-normal-animation-duration);
  animation-timing-function: var(--winui-control-fast-out-slow-in-easing);
}

.fui-MenuPopover.fui-MenuPopover[data-popper-placement^='top'] {
  --winui-menu-reveal-offset: 50%;
  --winui-menu-reveal-leading: -32px;
  --winui-menu-reveal-trailing: 50%;
  --winui-menu-open-leading: -32px;
  --winui-menu-open-trailing: 0%;
}

.fui-MenuPopover.fui-MenuPopover[data-popper-placement] {
  animation-name: winui-menu-flyout-reveal;
}

/* The reveal moves and resizes the surface, so it goes when the OS says motion
   goes. The fade the presence component still runs on close is opacity, which
   WCAG excludes from motion animation, and Fluent clamps it under the same
   preference anyway. */
@media (prefers-reduced-motion: reduce) {
  .fui-MenuPopover.fui-MenuPopover[data-popper-placement] {
    animation-duration: 0.01ms;
  }
}
`;
