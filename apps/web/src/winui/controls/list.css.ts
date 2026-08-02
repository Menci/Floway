// List and ListItem, restyled from the Fluent 2 Web look to WinUI 3. Fluent's
// list is headless -- no fill, no radius, no state -- so every rule below adds
// a state rather than replacing a Fluent value.
//
// Interaction states are keyed off `[tabindex]`, which useListItem gives an
// item exactly when selection or navigation makes it interactive, so a plain
// content row keeps the flat look Fluent gives it. See ./tokens.ts for the
// selector convention.
//
// Windows High Contrast is transcribed here rather than handed back to Fluent,
// because a headless list states none of it and forced colours would otherwise
// flatten the row to one appearance. The check box inside the row keeps
// Fluent's forced-colours drawing, for the reason ./choice.css writes down.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L83-L93
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L150-L154
export const listCss = `
/* The item body, and the containing block for the two chrome layers this sheet
   draws inside it: the selection indicator and the focus ring's inner stroke.
   The rest fill is SubtleFillColorTransparent and ListViewItemForeground is
   TextFillColorPrimary, both of which the undeclared default already paints.
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

/* The subtle fill ramp, which only an interactive row runs. useListItem gives
   an item a tabindex exactly when selection or navigation is on, so that
   attribute is the hook.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L18-L19
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L24-L25 */
.fui-ListItem.fui-ListItem[tabindex]:not([aria-disabled='true']):hover {
  background-color: var(--winui-subtle-fill-secondary);
}

.fui-ListItem.fui-ListItem[tabindex]:not([aria-disabled='true']):active {
  background-color: var(--winui-subtle-fill-tertiary);
}

/* Selection: the same ramp one step up. A disabled selected row keeps the
   secondary rest fill, so the enabled-only guards cover it and no separate rule
   is needed.
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

/* The selection indicator. ListViewItem states its brush and its 1.5px corner
   radius, and that radius fixes the width -- a full round-off is one only on a
   3px bar.

   The length departs from WinUI deliberately. The presenter sizes the bar by
   MAX(16, itemHeight - 40), a flat 16px on this 40px row; a quarter inset at
   each end reproduces roughly that length here while holding the bar's
   proportion as the row height changes, rather than leaving it short in a tall
   row.

   Departure is the fade alone: WinUI registers no scale key frame on deselect
   and destroys the rectangle once the 83ms is up, so the height snaps back
   after the fade rather than shrinking with it.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L57
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L60
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L75
   https://github.com/microsoft/microsoft-ui-xaml/blob/543310634592831f8f2638301ece05d2d2dbea39/src/dxaml/xcp/core/core/elements/ListViewBaseItemChrome.cpp#L1750-L1758
   https://github.com/microsoft/microsoft-ui-xaml/blob/543310634592831f8f2638301ece05d2d2dbea39/src/dxaml/xcp/dxaml/lib/ListViewBaseItemPresenter_Partial.cpp#L945-L982 */
.fui-ListItem.fui-ListItem::before {
  content: '';
  position: absolute;
  inset-inline-start: 0;
  inset-block: 25%;
  inline-size: 3px;
  border-radius: 1.5px;
  background-color: var(--winui-accent-fill-default);
  pointer-events: none;
  opacity: 0;
  scale: 1 0;
  transition:
    opacity 83ms linear,
    scale 0s linear 83ms;
}

.fui-ListItem.fui-ListItem[aria-selected='true']::before {
  opacity: 1;
  scale: 1 1;
  transition:
    opacity 83ms linear,
    scale 167ms cubic-bezier(0.167, 0.167, 0, 1);
}

@media (prefers-reduced-motion: reduce) {
  .fui-ListItem.fui-ListItem::before,
  .fui-ListItem.fui-ListItem[aria-selected='true']::before {
    transition-duration: 0.01ms;
    transition-delay: 0s;
  }
}

/* Disablement. WinUI drops ContentBorder -- the row's fill and its content
   together -- to 0.3, so one opacity carries the whole row. The selection
   indicator is the exception: it names a disabled brush of its own.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L6
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L78
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L381 */
.fui-ListItem.fui-ListItem[aria-disabled='true'] {
  opacity: 0.3;
}

.fui-ListItem.fui-ListItem[aria-disabled='true']::before {
  background-color: var(--winui-accent-fill-disabled);
}

/* Focus. WinUI draws an outer 2px stroke with an inner 1px nested inside it,
   held a pixel clear of the row's edge by FocusVisualMargin 1 -- a positive
   margin shrinks the focus rectangle, so the ring is drawn inside the item's
   bounds. Retinting Fluent's single outline and pulling it in by the outer
   stroke's full reach places the primary stroke exactly.

   The inner stroke rides a pseudo-element; an inset shadow on the row itself
   would sit in the pixels the outline has to cover. Under forced colours the
   user agent drops that shadow and forces the outline onto CanvasText, which
   is that mode's reading of the HighContrast WindowText, so the ring needs no
   colour of its own there.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L29-L30
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L94
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L248
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L250
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L252
   https://github.com/microsoft/microsoft-ui-xaml/blob/543310634592831f8f2638301ece05d2d2dbea39/src/dxaml/xcp/components/FocusRect/FocusRectManager.cpp#L173-L174
   https://github.com/microsoft/microsoft-ui-xaml/blob/543310634592831f8f2638301ece05d2d2dbea39/src/dxaml/xcp/components/FocusRect/FocusRectManager.cpp#L718
   https://drafts.csswg.org/css-color-adjust/#forced-colors-properties */
.fui-ListItem.fui-ListItem[data-fui-focus-visible] {
  --colorStrokeFocus2: var(--winui-focus-stroke-outer);
  outline-offset: -3px;
}

.fui-ListItem.fui-ListItem[data-fui-focus-visible]::after {
  content: '';
  position: absolute;
  inset: 3px;
  border-radius: 1px;
  box-shadow: inset 0 0 0 1px var(--winui-focus-stroke-inner);
  pointer-events: none;
}

/* The selection check box, whose fills and glyph belong to ./choice.css. The
   corner radius is the one measure ListViewItem states for its own check box,
   a pixel wider than Fluent's indicator reset.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L59 */
.fui-ListItem__checkmark .fui-Checkbox__indicator.fui-Checkbox__indicator {
  border-radius: 3px;
}

/* Where the two dictionaries part is the unselected box. A standalone CheckBox
   walks the alt-fill ramp per state; ListViewItem names one fill for
   pointer-over, pressed and disabled alike and holds the stroke through the
   pressed state, so the box the row carries stays still while the row
   underneath it moves.

   Each selector repeats the shape of the ./choice.css rule it answers and adds
   the checkmark slot, so it outranks that rule wherever the two sheets meet.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L34
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L63-L65
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L72 */
@media not (forced-colors: active) {
  .fui-ListItem__checkmark.fui-Checkbox:hover
    .fui-Checkbox__input:enabled:not(:checked):not(:indeterminate)
    ~ .fui-Checkbox__indicator.fui-Checkbox__indicator,
  .fui-ListItem__checkmark.fui-Checkbox:active
    .fui-Checkbox__input:enabled:not(:checked):not(:indeterminate)
    ~ .fui-Checkbox__indicator.fui-Checkbox__indicator,
  .fui-ListItem__checkmark
    .fui-Checkbox__input:disabled:not(:checked):not(:indeterminate)
    ~ .fui-Checkbox__indicator.fui-Checkbox__indicator {
    background-color: var(--winui-control-alt-fill-secondary);
  }

  .fui-ListItem__checkmark.fui-Checkbox:active
    .fui-Checkbox__input:enabled:not(:checked):not(:indeterminate)
    ~ .fui-Checkbox__indicator.fui-Checkbox__indicator {
    border-color: var(--winui-control-strong-stroke-default);
  }
}

/* High Contrast. The selection indicator inverts with the row: its brush there
   is HighlightText, so the bar reads against the Highlight the row is now
   filled with.

   A media query carries no specificity, so each rule repeats the selector it
   answers.
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
