// WinUI 3 menu-flyout styling for Fluent v9's Menu family. Fluent paints a menu
// item as an opaque neutral card that deepens on hover and press, with the icon
// turning brand on hover; WinUI paints it as a transparent strip that picks up a
// translucent subtle fill, lighter on press than on hover, and holds one text
// brush across every state.
//
// The source dictionary is MenuFlyout_themeresources.xaml, which states the
// presenter, the item, the submenu item, the split item and the separator
// together. Its item fills repeat the ListViewItem values, but the menu keys are
// the ones transcribed here.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/MenuFlyout_themeresources.xaml#L270
//
// Menu and MenuTrigger render no element of their own, and MenuList declares
// only layout, so neither appears below.
//
// MenuItemCheckbox, MenuItemRadio, MenuItemSwitch and MenuItemLink each add a
// root class of their own and then run the MenuItem style hook, so every item
// rule below reaches all five roots and their shared slot classes. The
// `__checkmark` slot declares geometry only and takes the item's foreground by
// inheritance; `__submenuIndicator` carries the separate chevron ramp WinUI
// states for it.
export const menuCss = `
/* Flyout surface. WinUI rounds a flyout to the overlay radius and outlines it
   with the dedicated flyout stroke.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/MenuFlyout_themeresources.xaml#L285
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/MenuFlyout_themeresources.xaml#L41

   The presenter's Border is BackgroundSizing="InnerBorderEdge", which is
   background-clip: padding-box on the web: the fill stops at the border so the
   translucent stroke reads against whatever the flyout floats over.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/MenuFlyout_themeresources.xaml#L289

   The presenter's own fill is DesktopAcrylicTransparentBrush -- #00000000, a
   sentinel that hands the material to the window's DesktopAcrylicBackdrop. A
   web flyout floats over no such backdrop, so we paint the acrylic material's
   FallbackColor, which is what WinUI shows when transparency effects are off
   and is the same colour in the desktop and in-app families.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/MenuFlyout_themeresources.xaml#L40
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/MenuFlyout_themeresources.xaml#L264
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Materials/Acrylic/AcrylicBrush_themeresources.xaml#L95

   The presenter's padding is 0,2,0,2: the whole inline inset lives on the item
   instead, as the margin the item rule below carries.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/MenuFlyout_themeresources.xaml#L255 */
.fui-MenuPopover.fui-MenuPopover {
  background-clip: padding-box;
  background-color: var(--winui-acrylic-in-app-fill-default);
  border-radius: var(--winui-overlay-corner-radius);
  border-color: var(--winui-surface-stroke-flyout);
  padding: 2px 0;
}

/* Item at rest. Fluent gives the item its own opaque fill; WinUI leaves it
   transparent so the flyout surface shows through, and states one foreground
   brush that hover and press both reuse. The 4,2,4,2 margin is the item's own,
   and it is what holds the pill off the surface edge and off its neighbours.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/MenuFlyout_themeresources.xaml#L6
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/MenuFlyout_themeresources.xaml#L11
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/MenuFlyout_themeresources.xaml#L259 */
.fui-MenuItem.fui-MenuItem {
  background-color: var(--winui-subtle-fill-transparent);
  color: var(--winui-text-fill-primary);
  margin: 2px 4px;
}

/* WinUI's split item carries that margin once, on the grid that holds both
   halves and the divider between them, so the pair reads as a single pill.
   Fluent builds the same shape out of two MenuItems inside a group, and each of
   them would otherwise take the margin for itself and pull the halves apart.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/MenuFlyout_themeresources.xaml#L504 */
.fui-MenuSplitGroup.fui-MenuSplitGroup {
  margin: 2px 4px;
}

.fui-MenuSplitGroup .fui-MenuItem.fui-MenuItem {
  margin: 0;
}

/* The trailing hint is the keyboard-accelerator text, which WinUI paints
   secondary and holds there through hover and press. Fluent moves it on its own
   :hover and :focus, so the item root is named as well to clear those two rules
   by a class.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/MenuFlyout_themeresources.xaml#L31-L33 */
.fui-MenuItem .fui-MenuItem__secondaryContent.fui-MenuItem__secondaryContent {
  color: var(--winui-text-fill-secondary);
}

/* The icon takes the item's own colour instead of turning brand -- which Fluent
   does both on hover and while a submenu is open. WinUI drives IconContent from
   the same MenuFlyoutItemForeground* keys as the label, and those do not move.
   Inheriting covers the disabled item too, whose own brush is already the
   disabled one.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/MenuFlyout_themeresources.xaml#L321
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/MenuFlyout_themeresources.xaml#L11 */
.fui-MenuItem:hover .fui-MenuItem__icon.fui-MenuItem__icon,
.fui-MenuItem[aria-expanded='true'] .fui-MenuItem__icon.fui-MenuItem__icon {
  color: inherit;
}

/* The submenu chevron is the one slot WinUI gives a ramp of its own, subordinate
   to the label: secondary at rest, on hover and while the submenu is open,
   tertiary while pressed. Fluent leaves it inheriting the item's foreground, so
   both values are written here. The pressed rule steps around a disabled item so
   the disabled group below keeps the chevron without a deeper selector.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/MenuFlyout_themeresources.xaml#L26-L29 */
.fui-MenuItem .fui-MenuItem__submenuIndicator.fui-MenuItem__submenuIndicator {
  color: var(--winui-text-fill-secondary);
}

/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/MenuFlyout_themeresources.xaml#L28 */
.fui-MenuItem:not([aria-disabled='true']):hover:active .fui-MenuItem__submenuIndicator.fui-MenuItem__submenuIndicator {
  color: var(--winui-text-fill-tertiary);
}

/* Hover and press. WinUI moves the fill along the subtle ramp -- transparent to
   secondary to tertiary -- where Fluent walks the neutral-background ramp, and
   tertiary is the lighter of the two, so the item lifts on press rather than
   deepening. The foreground brush does not move in either state.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/MenuFlyout_themeresources.xaml#L7
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/MenuFlyout_themeresources.xaml#L12 */
.fui-MenuItem.fui-MenuItem:hover {
  background-color: var(--winui-subtle-fill-secondary);
  color: var(--winui-text-fill-primary);
}

/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/MenuFlyout_themeresources.xaml#L8
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/MenuFlyout_themeresources.xaml#L13 */
.fui-MenuItem.fui-MenuItem:hover:active {
  background-color: var(--winui-subtle-fill-tertiary);
  color: var(--winui-text-fill-primary);
}

/* WinUI states no description line under a menu item, so this slot's foreground
   is ours to settle. Its rest value already resolves to the WinUI tertiary brush
   through the token table; what Fluent adds on top is a hover and a pressed step
   whose tokens have no WinUI counterpart to map onto, so those two states would
   paint outside the palette. We hold the rest value across all three, which is
   how every foreground WinUI does state on this item behaves. */
.fui-MenuItem:not([aria-disabled='true']):hover .fui-MenuItem__subText.fui-MenuItem__subText,
.fui-MenuItem:not([aria-disabled='true']):hover:active .fui-MenuItem__subText.fui-MenuItem__subText {
  color: var(--winui-text-fill-tertiary);
}

/* Submenu open. A submenu trigger is held in the pointer-over fill for as long
   as its flyout is up, and its foreground stays primary. The hook is the
   aria-expanded attribute MenuTrigger renders unconditionally on a submenu
   child; the rest rule would otherwise strip Fluent's own open fill and leave
   the trigger flat. Only the fill is stated -- the rest rule already outranks
   Fluent's single-atom open foreground.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/MenuFlyout_themeresources.xaml#L18
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/MenuFlyout_themeresources.xaml#L24 */
.fui-MenuItem.fui-MenuItem[aria-expanded='true'] {
  background-color: var(--winui-subtle-fill-secondary);
}

/* Disabled. Fluent holds its opaque rest fill under the pointer; WinUI holds a
   transparent one. The foreground has to be written here as well: Fluent states
   it on a single atom, which the rest and hover rules above outrank, so leaving
   it to Fluent would paint a disabled item at full strength.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/MenuFlyout_themeresources.xaml#L9
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/MenuFlyout_themeresources.xaml#L14 */
.fui-MenuItem.fui-MenuItem[aria-disabled='true'],
.fui-MenuItem.fui-MenuItem[aria-disabled='true']:hover,
.fui-MenuItem.fui-MenuItem[aria-disabled='true']:hover:active {
  background-color: var(--winui-subtle-fill-transparent);
  color: var(--winui-text-fill-disabled);
}

/* The hint, the chevron and the sub-text follow the item into the disabled
   brush. The hint and the chevron are matched one class deeper than the rule
   that paints each at rest; the sub-text has no rest rule to outrank, and the
   two rules that hold it under the pointer already step around a disabled item.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/MenuFlyout_themeresources.xaml#L30
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/MenuFlyout_themeresources.xaml#L34 */
.fui-MenuItem[aria-disabled='true'] .fui-MenuItem__secondaryContent.fui-MenuItem__secondaryContent,
.fui-MenuItem[aria-disabled='true'] .fui-MenuItem__submenuIndicator.fui-MenuItem__submenuIndicator,
.fui-MenuItem[aria-disabled='true'] .fui-MenuItem__subText.fui-MenuItem__subText {
  color: var(--winui-text-fill-disabled);
}

/* Focus. Fluent draws one ring on a pseudo-element; the system focus visual
   WinUI puts on a menu item draws two concentric ones. The token Fluent's border
   reads is re-pointed on the pseudo-element itself, where that border resolves
   it, so the outer stroke lands without the substitution reaching any other
   descendant of the focused item. An inset shadow on the same pseudo-element --
   clipped to its padding box, so it sits immediately inside the 2px border --
   supplies the inner one.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/MenuFlyout_themeresources.xaml#L307
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L144
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L145 */
.fui-MenuItem.fui-MenuItem[data-fui-focus-visible]::after {
  --colorStrokeFocus2: var(--winui-focus-stroke-outer);
  box-shadow: inset 0 0 0 1px var(--winui-focus-stroke-inner);
}

/* Separator. WinUI has a stroke ramp of its own for dividers rather than
   borrowing a neutral control stroke.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/MenuFlyout_themeresources.xaml#L5
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L143 */
.fui-MenuDivider.fui-MenuDivider {
  border-bottom-color: var(--winui-divider-stroke-default);
}

/* MenuFlyout's open. WinUI reveals a menu rather than moving it: the presenter
   slides in from a fraction of its own height while a clip slides the other way
   by exactly as much, which pins the visible window to the final layout box and
   lets only the content travel through it. A menu below its trigger starts as
   its own lower fraction drawn at the top of the box and grows downward; one
   above starts as its upper fraction at the bottom and grows upward. Nothing
   fades in. 250ms on the fast-out-slow-in spline.

   The fraction is 0.5 for a menu and 0.67 for a submenu. Fluent renders both
   through the same components, but it places a submenu after its trigger and a
   menu below it, so the placement attribute tells them apart: an inline
   placement is a submenu, a block one a menu. A submenu also always grows
   downward, which is the branch it already inherits.

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
   https://github.com/microsoft/microsoft-ui-xaml/blob/543310634592831f8f2638301ece05d2d2dbea39/src/dxaml/xcp/dxaml/lib/MenuPopupThemeTransition_Partial.h#L23-L24
   https://github.com/microsoft/microsoft-ui-xaml/blob/543310634592831f8f2638301ece05d2d2dbea39/src/dxaml/xcp/dxaml/lib/MenuFlyout_Partial.cpp#L253
   https://github.com/microsoft/microsoft-ui-xaml/blob/543310634592831f8f2638301ece05d2d2dbea39/src/dxaml/xcp/dxaml/lib/MenuFlyoutSubItem_Partial.cpp#L741
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

.fui-MenuPopover.fui-MenuPopover[data-popper-placement^='right'],
.fui-MenuPopover.fui-MenuPopover[data-popper-placement^='left'] {
  --winui-menu-reveal-offset: -67%;
  --winui-menu-reveal-leading: 67%;
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
