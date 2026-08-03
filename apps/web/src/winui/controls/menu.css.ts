// WinUI 3 menu-flyout styling for Fluent v9's Menu family.
//
// The source dictionary is MenuFlyout_themeresources.xaml. Its item fills
// repeat the ListViewItem values, but the menu keys are the ones transcribed
// here.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/MenuFlyout_themeresources.xaml#L270
//
// MenuItemCheckbox, MenuItemRadio, MenuItemSwitch and MenuItemLink each add a
// root class of their own and then run the MenuItem style hook, so every item
// rule below reaches all five roots and their shared slot classes.
import { REVEAL_HEADROOM, revealAnimation } from './reveal';
import { reducedMotion } from './selectors';

export const menuCss = `
/* Flyout surface.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/MenuFlyout_themeresources.xaml#L285
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/MenuFlyout_themeresources.xaml#L41

   The presenter's own fill is DesktopAcrylicTransparentBrush -- #00000000, a
   sentinel that hands the material to the window's DesktopAcrylicBackdrop. A
   web flyout floats over no such backdrop, so we paint the acrylic material's
   FallbackColor, which is what WinUI shows when transparency effects are off.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/MenuFlyout_themeresources.xaml#L40
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/MenuFlyout_themeresources.xaml#L264
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Materials/Acrylic/AcrylicBrush_themeresources.xaml#L95

   The presenter's padding is 0,2,0,2: the whole inline inset lives on the item
   instead, as the margin the item rule below carries.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/MenuFlyout_themeresources.xaml#L255 */
.fui-MenuPopover.fui-MenuPopover {
  background-color: var(--winui-acrylic-in-app-fill-default);
  border-radius: var(--winui-overlay-corner-radius);
  border-color: var(--winui-surface-stroke-flyout);
  padding: 2px 0;
}

/* Item at rest. The 4,2,4,2 margin is the item's own, and it is what holds the
   pill off the surface edge and off its neighbours.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/MenuFlyout_themeresources.xaml#L6
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/MenuFlyout_themeresources.xaml#L11
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/MenuFlyout_themeresources.xaml#L259 */
.fui-MenuItem.fui-MenuItem {
  background-color: var(--winui-subtle-fill-transparent);
  color: var(--winui-text-fill-primary);
  margin: 2px 4px;
}

/* The trailing hint is the keyboard-accelerator text, which WinUI holds
   secondary through hover and press. Fluent moves it on its own :hover and
   :focus, so the item root is named as well to clear those two rules by a
   class.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/MenuFlyout_themeresources.xaml#L31-L33 */
.fui-MenuItem .fui-MenuItem__secondaryContent.fui-MenuItem__secondaryContent {
  color: var(--winui-text-fill-secondary);
}

/* The icon takes the item's own colour instead of turning brand -- which Fluent
   does both on hover and while a submenu is open. WinUI drives IconContent from
   the same MenuFlyoutItemForeground* keys as the label, and those do not move.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/MenuFlyout_themeresources.xaml#L321
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/MenuFlyout_themeresources.xaml#L11 */
.fui-MenuItem:hover .fui-MenuItem__icon.fui-MenuItem__icon,
.fui-MenuItem[aria-expanded='true'] .fui-MenuItem__icon.fui-MenuItem__icon {
  color: inherit;
}

/* The check glyph runs its ramp the other way: secondary at rest, rising to the
   label's primary under the pointer, where the pressed value repeats the
   pointer-over one, so the hover rule carries both.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/MenuFlyout_themeresources.xaml#L488
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/MenuFlyout_themeresources.xaml#L420
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/MenuFlyout_themeresources.xaml#L429
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/RadioMenuFlyoutItem/RadioMenuFlyoutItem_themeresources.xaml#L94
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/RadioMenuFlyoutItem/RadioMenuFlyoutItem_themeresources.xaml#L24
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/RadioMenuFlyoutItem/RadioMenuFlyoutItem_themeresources.xaml#L33 */
.fui-MenuItem .fui-MenuItem__checkmark.fui-MenuItem__checkmark {
  color: var(--winui-text-fill-secondary);
}

.fui-MenuItem:not([aria-disabled='true']):hover .fui-MenuItem__checkmark.fui-MenuItem__checkmark {
  color: var(--winui-text-fill-primary);
}

/* The submenu chevron is subordinate to the label: secondary at rest, on hover
   and while the submenu is open, tertiary while pressed. The pressed rule steps
   around a disabled item so the disabled group below keeps the chevron without
   a deeper selector.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/MenuFlyout_themeresources.xaml#L26-L29 */
.fui-MenuItem .fui-MenuItem__submenuIndicator.fui-MenuItem__submenuIndicator {
  color: var(--winui-text-fill-secondary);
}

/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/MenuFlyout_themeresources.xaml#L28 */
.fui-MenuItem:not([aria-disabled='true']):hover:active .fui-MenuItem__submenuIndicator.fui-MenuItem__submenuIndicator {
  color: var(--winui-text-fill-tertiary);
}

/* Hover and press.
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

/* WinUI has no description line under a menu item, and Fluent's hover, pressed
   and submenu-open steps all read tokens outside the WinUI palette, so the rest
   value is held across every enabled state -- named as the absence of a state
   rather than as a list, so a Fluent atom on a state nobody enumerated cannot
   take it back. */
.fui-MenuItem:not([aria-disabled='true']) .fui-MenuItem__subText.fui-MenuItem__subText {
  color: var(--winui-text-fill-tertiary);
}

/* Submenu open. Without this the rest rule strips Fluent's own open fill and
   leaves the trigger flat.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/MenuFlyout_themeresources.xaml#L18
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/MenuFlyout_themeresources.xaml#L24 */
.fui-MenuItem.fui-MenuItem[aria-expanded='true'] {
  background-color: var(--winui-subtle-fill-secondary);
}

/* Disabled. Fluent states the foreground on a single atom, which the rest and
   hover rules above outrank, so it is restated here.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/MenuFlyout_themeresources.xaml#L9
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/MenuFlyout_themeresources.xaml#L14 */
.fui-MenuItem.fui-MenuItem[aria-disabled='true'],
.fui-MenuItem.fui-MenuItem[aria-disabled='true']:hover,
.fui-MenuItem.fui-MenuItem[aria-disabled='true']:hover:active {
  background-color: var(--winui-subtle-fill-transparent);
  color: var(--winui-text-fill-disabled);
}

/* Disabled slots, matched one class deeper than the rule that paints each at
   rest.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/MenuFlyout_themeresources.xaml#L30
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/MenuFlyout_themeresources.xaml#L34
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/MenuFlyout_themeresources.xaml#L437
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/RadioMenuFlyoutItem/RadioMenuFlyoutItem_themeresources.xaml#L41 */
.fui-MenuItem[aria-disabled='true'] .fui-MenuItem__secondaryContent.fui-MenuItem__secondaryContent,
.fui-MenuItem[aria-disabled='true'] .fui-MenuItem__submenuIndicator.fui-MenuItem__submenuIndicator,
.fui-MenuItem[aria-disabled='true'] .fui-MenuItem__checkmark.fui-MenuItem__checkmark,
.fui-MenuItem[aria-disabled='true'] .fui-MenuItem__subText.fui-MenuItem__subText {
  color: var(--winui-text-fill-disabled);
}

/* Focus. WinUI draws two concentric rings where Fluent draws one: the token is
   re-pointed on the pseudo-element itself, so the substitution reaches no other
   descendant of the focused item, and an inset shadow there supplies the inner
   ring.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/MenuFlyout_themeresources.xaml#L307
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L144
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L145 */
.fui-MenuItem.fui-MenuItem[data-fui-focus-visible]::after {
  box-shadow: inset 0 0 0 var(--winui-focus-visual-secondary-thickness) var(--winui-focus-stroke-inner);
}

/* Separator: 1px off its neighbours, and out to the presenter's edges — our
   popover carries no inline padding, so zero already reaches them.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/MenuFlyout_themeresources.xaml#L5
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/MenuFlyout_themeresources.xaml#L254
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/MenuFlyout_themeresources.xaml#L258
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/MenuFlyout_themeresources.xaml#L733
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L143 */
.fui-MenuDivider.fui-MenuDivider {
  border-bottom-color: var(--winui-divider-stroke-default);
  margin: 1px 0;
}

/* High Contrast. Every slot this sheet colours has to be restated here: a
   colour we pin resolves to the forced palette's plain text entry, which would
   leave the hint, the chevron and the check glyph reading against the Highlight
   the row is now filled with. The sub-text has no counterpart in the
   dictionary, so it follows the row it sits in, the only value legible over
   both fills.

   The presenter's doubled border is WinUI's own; its fill and stroke, and the
   separator's, are left unstated because they already resolve to the Window and
   WindowText the dictionary names.

   A media query carries no specificity, so each rule repeats the selector it
   answers.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/MenuFlyout_themeresources.xaml#L90-L97
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/MenuFlyout_themeresources.xaml#L101
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/MenuFlyout_themeresources.xaml#L107
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/MenuFlyout_themeresources.xaml#L109-L113
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/MenuFlyout_themeresources.xaml#L114-L117
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/MenuFlyout_themeresources.xaml#L125
   https://drafts.csswg.org/css-color-adjust/#forced-colors-properties */
@media (forced-colors: active) {
  .fui-MenuPopover.fui-MenuPopover {
    border-width: 2px;
  }

  .fui-MenuItem .fui-MenuItem__secondaryContent.fui-MenuItem__secondaryContent {
    color: CanvasText;
  }

  .fui-MenuItem .fui-MenuItem__submenuIndicator.fui-MenuItem__submenuIndicator,
  .fui-MenuItem .fui-MenuItem__checkmark.fui-MenuItem__checkmark {
    color: ButtonText;
  }

  .fui-MenuItem.fui-MenuItem[aria-expanded='true'] {
    background-color: Canvas;
    color: Highlight;
  }

  .fui-MenuItem[aria-expanded='true'] .fui-MenuItem__submenuIndicator.fui-MenuItem__submenuIndicator,
  .fui-MenuItem[aria-expanded='true'] .fui-MenuItem__subText.fui-MenuItem__subText {
    color: Highlight;
  }

  .fui-MenuItem.fui-MenuItem:hover,
  .fui-MenuItem.fui-MenuItem:hover:active {
    background-color: Highlight;
    color: HighlightText;
  }

  .fui-MenuItem:not([aria-disabled='true']):hover .fui-MenuItem__secondaryContent.fui-MenuItem__secondaryContent,
  .fui-MenuItem:not([aria-disabled='true']):hover .fui-MenuItem__checkmark.fui-MenuItem__checkmark,
  .fui-MenuItem:not([aria-disabled='true']):hover .fui-MenuItem__submenuIndicator.fui-MenuItem__submenuIndicator,
  .fui-MenuItem:not([aria-disabled='true']):hover:active .fui-MenuItem__submenuIndicator.fui-MenuItem__submenuIndicator,
  .fui-MenuItem:not([aria-disabled='true']):hover .fui-MenuItem__subText.fui-MenuItem__subText,
  .fui-MenuItem:not([aria-disabled='true']):hover:active .fui-MenuItem__subText.fui-MenuItem__subText {
    color: HighlightText;
  }

  .fui-MenuItem.fui-MenuItem[aria-disabled='true'],
  .fui-MenuItem.fui-MenuItem[aria-disabled='true']:hover,
  .fui-MenuItem.fui-MenuItem[aria-disabled='true']:hover:active {
    background-color: Canvas;
    color: GrayText;
  }

  .fui-MenuItem[aria-disabled='true'] .fui-MenuItem__secondaryContent.fui-MenuItem__secondaryContent,
  .fui-MenuItem[aria-disabled='true'] .fui-MenuItem__submenuIndicator.fui-MenuItem__submenuIndicator,
  .fui-MenuItem[aria-disabled='true'] .fui-MenuItem__checkmark.fui-MenuItem__checkmark,
  .fui-MenuItem[aria-disabled='true'] .fui-MenuItem__subText.fui-MenuItem__subText {
    color: GrayText;
  }
}

/* MenuFlyout's open. WinUI reveals a menu rather than moving it: the presenter
   slides in from a fraction of its own height while a clip slides the other way
   by exactly as much, which pins the visible window to the final layout box and
   lets only the content travel through it. Nothing fades in.

   The fraction is 0.5 for a menu and 0.67 for a submenu. Fluent renders both
   through the same components, but it places a submenu after its trigger and a
   menu below it, so the placement attribute tells them apart: an inline
   placement is a submenu, a block one a menu.

   This lives here rather than in ../presence.ts because the direction cannot be
   read when a presence factory runs. createPresenceComponent calls the factory
   synchronously inside a layout effect, and Fluent's positioning writes
   data-popper-placement a few milliseconds later, so an element.getAttribute
   there is always null -- every menu took the downward branch, including the
   ones that flipped. CSS re-resolves when the attribute lands, which is before
   the first frame is painted; ./reveal.ts records the rest of that mechanism.

   The slide is written to translate rather than into transform, for the reason
   ./reveal.ts gives for the clip. Beyond the travelling edge lies the element's
   own translated body, which a clip cannot tell from shadow, so a negative
   value there lets the surface overshoot its final position mid-reveal.

   The close is not here. It is a bare 83ms fade that has to hold the surface
   mounted while it runs, which only a presence component can do --
   ../presence.ts keeps it.
   https://github.com/microsoft/microsoft-ui-xaml/blob/543310634592831f8f2638301ece05d2d2dbea39/src/dxaml/xcp/dxaml/lib/MenuPopupThemeTransition_Partial.h#L23-L24
   https://github.com/microsoft/microsoft-ui-xaml/blob/543310634592831f8f2638301ece05d2d2dbea39/src/dxaml/xcp/dxaml/lib/MenuFlyout_Partial.cpp#L253
   https://github.com/microsoft/microsoft-ui-xaml/blob/543310634592831f8f2638301ece05d2d2dbea39/src/dxaml/xcp/dxaml/lib/MenuFlyoutSubItem_Partial.cpp#L741
   https://github.com/microsoft/microsoft-ui-xaml/blob/543310634592831f8f2638301ece05d2d2dbea39/src/dxaml/xcp/dxaml/lib/LayoutTransition_partial.cpp#L423-L563 */
@keyframes winui-menu-flyout-reveal {
  from {
    translate: 0 var(--winui-menu-reveal-offset);
    clip-path: inset(
      var(--winui-menu-reveal-leading) ${REVEAL_HEADROOM} var(--winui-menu-reveal-trailing) ${REVEAL_HEADROOM});
  }
  to {
    translate: 0 0;
    clip-path: inset(
      var(--winui-menu-open-leading) ${REVEAL_HEADROOM} var(--winui-menu-open-trailing) ${REVEAL_HEADROOM});
  }
}

${revealAnimation({
  root: '.fui-MenuPopover.fui-MenuPopover',
  keyframes: 'winui-menu-flyout-reveal',
  properties: [
    '--winui-menu-reveal-offset: -50%;',
    '--winui-menu-reveal-leading: 50%;',
    `--winui-menu-reveal-trailing: ${REVEAL_HEADROOM};`,
    '--winui-menu-open-leading: 0%;',
    `--winui-menu-open-trailing: ${REVEAL_HEADROOM};`,
  ],
})}

.fui-MenuPopover.fui-MenuPopover[data-popper-placement^='top'] {
  --winui-menu-reveal-offset: 50%;
  --winui-menu-reveal-leading: ${REVEAL_HEADROOM};
  --winui-menu-reveal-trailing: 50%;
  --winui-menu-open-leading: ${REVEAL_HEADROOM};
  --winui-menu-open-trailing: 0%;
}

.fui-MenuPopover.fui-MenuPopover[data-popper-placement^='right'],
.fui-MenuPopover.fui-MenuPopover[data-popper-placement^='left'] {
  --winui-menu-reveal-offset: -67%;
  --winui-menu-reveal-leading: 67%;
}

/* The reveal moves and resizes the surface, so it goes when the OS says motion
   goes. The close fade is opacity, which WCAG excludes from motion animation. */
${reducedMotion(['.fui-MenuPopover.fui-MenuPopover[data-popper-placement]'], 'animation-duration')}
`;
