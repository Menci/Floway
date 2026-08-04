// List and ListItem, restyled to WinUI 3. Fluent's list is headless -- no fill,
// no radius, no state -- so every rule below adds a state rather than replacing
// a Fluent value.
import { checkboxNotMixed, uncheckedBox } from './choice.css';
import { selectionPill } from './selection-pill';
import { nested, pressedRoots, reducedMotion, under } from './selectors';

const checkmarkPressed = pressedRoots('.fui-ListItem__checkmark.fui-Checkbox', '.fui-Checkbox__input');

const interactiveRow = ".fui-ListItem[tabindex]:not([aria-disabled='true'])";

// ListViewItem sets FocusVisualMargin 1, and a positive margin shrinks the
// focus rectangle, so the ring starts a pixel inside the row and its inner
// stroke starts one primary thickness further in. That distance places the
// outline, the inner stroke's box, and the radius that box has to carry.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L248
const innerStrokeInset = 'calc(1px + var(--winui-focus-visual-primary-thickness))';

const selectedBox = '.fui-ListItem__checkmark .fui-Checkbox__input:enabled:checked'
  + ' ~ .fui-Checkbox__indicator.fui-Checkbox__indicator';

export const listCss = `
/* Also the containing block for the selection indicator and the focus ring's
   inner stroke. Rest fill and foreground are left undeclared: Fluent's default
   already paints SubtleFillColorTransparent over TextFillColorPrimary.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L13
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L14
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L17
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L23
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L58
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L241
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L244 */
.fui-ListItem.fui-ListItem {
  position: relative;
  min-height: 40px;
  min-width: 88px;
  padding-inline: 16px 12px;
  border-radius: var(--winui-control-corner-radius);
}

/* useListItem gives an item a tabindex exactly when selection or navigation is
   on, so that attribute is the hook for the interactive-only fill ramp.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L18-L19
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L24-L25 */
.fui-ListItem.fui-ListItem[tabindex]:not([aria-disabled='true']):hover {
  background-color: var(--winui-subtle-fill-secondary);
}

.fui-ListItem.fui-ListItem[tabindex]:not([aria-disabled='true']):active {
  background-color: var(--winui-subtle-fill-tertiary);
}

/* A disabled selected row keeps the secondary rest fill, so the enabled-only
   guards below cover it and no separate rule is needed.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L20-L22
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L74 */
.fui-ListItem.fui-ListItem[aria-selected='true'] {
  background-color: var(--winui-subtle-fill-secondary);
}

.fui-ListItem.fui-ListItem[aria-selected='true']:not([aria-disabled='true']):hover {
  background-color: var(--winui-subtle-fill-tertiary);
}

.fui-ListItem.fui-ListItem[aria-selected='true']:not([aria-disabled='true']):active {
  background-color: var(--winui-subtle-fill-secondary);
}

/* The selection indicator, on the shared pill geometry. ListViewItem states its
   own 1.5px corner radius, which is the full round-off of the shared 3px bar.
   On deselect WinUI registers no scale key frame and destroys the rectangle
   once the fade is up, so the height snaps back after it rather than shrinking
   with it.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L57
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L60
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L75 */
.fui-ListItem.fui-ListItem::before {
  content: '';
  position: absolute;
  inset-inline-start: 0;
${selectionPill('1.5px')}
  background-color: var(--winui-accent-fill-default);
  pointer-events: none;
  opacity: 0;
  scale: 1 0;
  transition:
    opacity var(--winui-control-faster-animation-duration) linear,
    scale 0s linear var(--winui-control-faster-animation-duration);
}

.fui-ListItem.fui-ListItem[aria-selected='true']::before {
  opacity: 1;
  scale: 1 1;
  transition:
    opacity var(--winui-control-faster-animation-duration) linear,
    scale var(--winui-control-fast-animation-duration) cubic-bezier(0.167, 0.167, 0, 1);
}

${reducedMotion([
  '.fui-ListItem.fui-ListItem::before',
  ".fui-ListItem.fui-ListItem[aria-selected='true']::before",
], 'transition-duration', ['transition-delay: 0s;'])}

/* On the rounded chrome path the disabled opacity lands on the item's template
   child alone, and GetTemplateChildIfExists returns nothing for the backplate,
   the selection indicator or the multi-select check box -- which is why each of
   those names a disabled brush of its own. A CSS group opacity cannot spare a
   pseudo-element or a slot, so the content is dimmed through its colour
   instead: the row's text carries TextFillColorPrimary, so 30% of it is what
   the animation would have produced -- written out per scheme because the
   source already carries an alpha of its own, and not to be mistaken for
   --winui-text-fill-disabled, which WinUI reaches by another route and which
   resolves to a different alpha in each scheme. A descendant that states its
   own colour keeps it, where WinUI would have faded it with the rest.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L6
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L78
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/core/core/elements/ListViewBaseItemChrome.cpp#L888-L916
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/core/core/elements/ListViewBaseItemChrome.cpp#L3290-L3312 */
.fui-ListItem.fui-ListItem[aria-disabled='true'] {
  /* 30% of --winui-text-fill-primary (#000000e4). */
  color: #00000044;
}

@media (prefers-color-scheme: dark) {
  /* 30% of --winui-text-fill-primary (#ffffff). */
  .fui-ListItem.fui-ListItem[aria-disabled='true'] {
    color: #ffffff4d;
  }
}

.fui-ListItem.fui-ListItem[aria-disabled='true']::before {
  background-color: var(--winui-accent-fill-disabled);
}

/* The inner stroke rides a pseudo-element because an inset shadow on the row
   itself would sit in the pixels the outline has to cover; under forced colours
   the user agent drops that shadow and forces the outline onto CanvasText, so
   the ring needs no colour of its own there. The pseudo-element is a rounded
   rectangle inset inside the row, so it carries the row's radius less that
   inset.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L29-L30
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L94
   https://github.com/microsoft/microsoft-ui-xaml/blob/543310634592831f8f2638301ece05d2d2dbea39/src/dxaml/xcp/components/FocusRect/FocusRectManager.cpp#L718
   https://drafts.csswg.org/css-color-adjust/#forced-colors-properties */
.fui-ListItem.fui-ListItem[data-fui-focus-visible] {
  outline-offset: calc(-1 * ${innerStrokeInset});
}

.fui-ListItem.fui-ListItem[data-fui-focus-visible]::after {
  content: '';
  position: absolute;
  inset: ${innerStrokeInset};
  border-radius: calc(var(--winui-control-corner-radius) - ${innerStrokeInset});
  box-shadow: inset 0 0 0 var(--winui-focus-visual-secondary-thickness) var(--winui-focus-stroke-inner);
  pointer-events: none;
}

/* The one measure ListViewItem states for its own check box, a pixel wider than
   Fluent's indicator reset.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L59 */
.fui-ListItem__checkmark .fui-Checkbox__indicator.fui-Checkbox__indicator {
  border-radius: 3px;
}

/* Where the two dictionaries part is the unselected box. A standalone CheckBox
   walks the alt-fill ramp per state; ListViewItem names one fill for
   pointer-over, pressed and disabled alike and holds the stroke through the
   pressed state, so the box the row carries stays still while the row
   underneath it moves. Each selector repeats the shape of the ./choice.css rule
   it answers and adds the checkmark slot, so it outranks that rule wherever the
   two sheets meet.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L34
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L63-L65
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L72 */
@media not (forced-colors: active) {
${nested(under(['.fui-ListItem__checkmark.fui-Checkbox:hover', ...checkmarkPressed], [uncheckedBox]))},
  .fui-ListItem__checkmark
    .fui-Checkbox__input:disabled:not(:checked)${checkboxNotMixed}
    ~ .fui-Checkbox__indicator.fui-Checkbox__indicator {
    background-color: var(--winui-control-alt-fill-secondary);
  }

${nested(under(checkmarkPressed, [uncheckedBox]))} {
    border-color: var(--winui-control-strong-stroke-default);
  }

  /* The selected box answers the row, not itself. WinUI builds it as a border
     with IsHitTestVisible false and picks its fill from the ITEM visual state,
     so the accent step arrives whenever the pointer is anywhere over the row;
     a standalone CheckBox instead steps when the box itself is hovered, which
     is the subject ./choice.css writes. Each rule therefore re-hangs that step
     on the row, and outranks the choice rule it answers by naming the row as
     well as the box. Pressed follows hover in source order because the two
     carry the same weight and WinUI resolves PressedSelected above
     PointerOverSelected; it also drops the glyph one step, which no other
     state of this box does.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/core/core/elements/ListViewBaseItemChrome.cpp#L3832
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/core/core/elements/ListViewBaseItemChrome.cpp#L4628-L4655
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/core/core/elements/ListViewBaseItemChrome.cpp#L4763-L4775
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L61
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L67
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L68 */
  ${interactiveRow}:hover ${selectedBox} {
    background-color: var(--winui-accent-fill-secondary);
    border-color: var(--winui-accent-fill-secondary);
  }

  ${interactiveRow}:active ${selectedBox} {
    background-color: var(--winui-accent-fill-tertiary);
    border-color: var(--winui-accent-fill-tertiary);
    color: var(--winui-text-on-accent-fill-secondary);
  }
}

/* High Contrast. The selection indicator inverts with the row: its brush there
   is HighlightText, so the bar reads against the Highlight the row is now
   filled with. A media query carries no specificity, so each rule repeats the
   selector it answers.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L83-L93
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L150-L151
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L154
   https://drafts.csswg.org/css-color-adjust/#forced-colors-properties */
@media (forced-colors: active) {
  .fui-ListItem.fui-ListItem[tabindex]:not([aria-disabled='true']):hover,
  .fui-ListItem.fui-ListItem[tabindex]:not([aria-disabled='true']):active,
  .fui-ListItem.fui-ListItem[aria-selected='true'] {
    background-color: Highlight;
    color: HighlightText;
  }

  .fui-ListItem.fui-ListItem[aria-selected='true'][aria-disabled='true'] {
    background-color: Canvas;
    color: ButtonText;
  }

  .fui-ListItem.fui-ListItem::before {
    background-color: HighlightText;
  }

  .fui-ListItem.fui-ListItem[aria-disabled='true']::before {
    background-color: GrayText;
  }
}
`;
