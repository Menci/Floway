// List and ListItem, restyled from the Fluent 2 Web look to WinUI 3. Fluent's
// list is a headless one: the item carries a list reset, a focus ring, and a
// cursor, and nothing else — no fill, no radius, no state. WinUI paints all of
// that in ListViewItemPresenter, so every rule below adds a state rather than
// replacing a Fluent value.
//
// The presenter is native code, so the theme dictionary states its brushes,
// radii and item metrics while its internal geometry and its motion are read
// out of the presenter's own source. The selection indicator's length is the
// one measure this sheet knowingly draws differently, and it says so at its
// rule.
//
// Interaction states are keyed off `[tabindex]`, which useListItem gives an
// item exactly when selection or navigation makes it interactive, so a plain
// content row keeps the flat look Fluent gives it. Selection and disablement
// come from `aria-selected` and `aria-disabled`, which the same hook writes
// whenever the list runs in a selection mode. See ./tokens.ts for the selector
// convention.
//
// Windows High Contrast is transcribed here rather than handed back to Fluent.
// The HighContrast dictionary maps every pointer and selection fill onto
// Highlight with a HighlightText foreground, holds a selected disabled row on
// Window, and paints the selection indicator in HighlightText against that
// Highlight fill -- none of which a headless list states, so forced colours
// would otherwise flatten the row to one appearance. The check box inside the
// row keeps Fluent's forced-colours drawing, for the reason ./choice.css
// writes down for every check box.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L83-L93
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L150-L154
export const listCss = `
/* The item body. WinUI rounds the row, holds it to the list's item height, and
   states both a content padding (16,0,12,0) and a minimum width (88) on the
   plain item style a stacked list uses. Fluent's reset pins the padding to 0
   and declares neither height nor width, so all four are stated here. The rest
   fill is SubtleFillColorTransparent, which is what an undeclared background
   already paints. ListViewItemForeground is TextFillColorPrimary, which is
   where the theme layer already points colorNeutralForeground1, so a
   foreground rule here would only restate it -- the same reason ./text.css
   declines one.

   The row is the containing block for the two chrome layers this sheet draws
   inside it: the selection indicator and the focus ring's inner stroke.
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
   attribute is the hook; the foreground stays at the rest fill throughout,
   since PointerOver and Pressed both restate TextFillColorPrimary.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L18-L19
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L24-L25 */
.fui-ListItem.fui-ListItem[tabindex]:not([aria-disabled='true']):hover {
  background-color: var(--winui-subtle-fill-secondary);
}

.fui-ListItem.fui-ListItem[tabindex]:not([aria-disabled='true']):active {
  background-color: var(--winui-subtle-fill-tertiary);
}

/* Selection. The fill takes the same ramp one step up: secondary when selected,
   tertiary once the pointer is over it, and back to secondary while pressed.
   A disabled selected row keeps the secondary fill, which is the rest value, so
   the enabled-only guard above covers it and no separate rule is needed.
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

/* The selection indicator: the accent bar WinUI runs down the leading edge of a
   selected row. ListViewItem states its brush, its enabled flag and its 1.5px
   corner radius, and the radius fixes the width -- a full round-off is one only
   on a 3px bar.

   The length follows the operator's instruction rather than a WinUI measure:
   the indicator is to be derived from the row height by a formula that
   hardcodes nothing and reproduces the stock length at the stock row height.
   The presenter sizes the bar by MAX(16, itemHeight - 40), which on this 40px
   row is a flat 16px; a quarter inset at each end gives 20px here and holds
   the bar's proportion as the row height changes rather than leaving it short
   in a tall row.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L57
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L60
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L75
   https://github.com/microsoft/microsoft-ui-xaml/blob/543310634592831f8f2638301ece05d2d2dbea39/src/dxaml/xcp/core/core/elements/ListViewBaseItemChrome.cpp#L1750-L1758

   The bar arrives on its own rather than travelling from the row that lost the
   selection: the presenter runs one storyboard per item, and two rows changing
   selection simply overlap in time. A travelling indicator is NavigationView's
   alone in this corpus.

   Arrival fades in over 83ms linear while the bar grows from nothing to full
   height over 167ms on the cubic Bezier through (0.167, 0.167) and (0, 1),
   from its own centre. Departure is the fade alone: WinUI registers no scale
   key frame on deselect and destroys the rectangle once the 83ms is up, so the
   height snaps back after the fade rather than shrinking with it. The bar
   therefore lives on every row and carries its state in its values, not in
   whether it exists.

   Fluent draws no indicator on a list item at all, so there is no Fluent motion
   to stand aside for: the timing is stated unconditionally and clamped under
   reduce -- see ../index.ts for the two shapes and which is which.
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

/* Disablement. Fluent only softens the cursor; WinUI drops ContentBorder -- the
   row's fill and its content together -- to 0.3, so one opacity on the item
   carries the whole row.

   The selection indicator is the one thing that opacity does not account for:
   it names a disabled brush of its own, so a disabled selected row draws the
   bar in the disabled accent rather than the default one.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L6
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L78
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L381 */
.fui-ListItem.fui-ListItem[aria-disabled='true'] {
  opacity: 0.3;
}

.fui-ListItem.fui-ListItem[aria-disabled='true']::before {
  background-color: var(--winui-accent-fill-disabled);
}

/* Focus. WinUI draws two strokes on a row -- an outer 2px in
   FocusStrokeColorOuter with an inner 1px in FocusStrokeColorInner nested
   inside it -- and holds the pair a pixel clear of the row's edge with
   FocusVisualMargin 1: a positive margin shrinks the focus rectangle, so the
   ring is drawn inside the item's bounds rather than around them. Rows in a
   list carry no margin, so that pixel is what keeps the ring off the boundary
   the row shares with the one above.

   Fluent's ring is a single 2px outline in --colorStrokeFocus2 at a radius the
   item already shares with WinUI, so retinting that token and pulling it in by
   the outer stroke's full reach places WinUI's primary stroke exactly. The
   inner stroke rides a pseudo-element inset to that stroke's inner edge; an
   inset shadow on the row itself would sit in the pixels the outline has to
   cover.

   Under forced colours the user agent drops the inner stroke's shadow and
   forces the outline onto CanvasText, which is that mode's reading of the
   WindowText the HighContrast dictionary states for the outer ring, so the
   ring keeps its geometry and needs no colour of its own there.
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

/* The selection check box. Its accent fills, its stroke and its glyph belong to
   ./choice.css, which restyles every Checkbox; the corner radius is the one
   measure ListViewItem states for its own check box, and it is a pixel wider
   than the radius Fluent's indicator reset carries.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L59 */
.fui-ListItem__checkmark .fui-Checkbox__indicator.fui-Checkbox__indicator {
  border-radius: 3px;
}

/* Where the two dictionaries part is the unselected box. A standalone CheckBox
   washes its cavity one step further down the alt-fill ramp per state and
   softens its stroke while pressed; ListViewItem names one fill --
   ControlAltFillColorSecondary -- for pointer-over, pressed and disabled alike
   and holds the stroke at ControlStrongStrokeColorDefault through the pressed
   state, so the box the row carries stays still while the row underneath it
   moves. The selected box is the same accent ramp in both dictionaries and is
   left to ./choice.css.

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

/* High Contrast. Every pointer and selection fill collapses onto Highlight with
   a HighlightText foreground, and the selection indicator inverts with them:
   its brush there is HighlightText, so the bar reads against the Highlight the
   row is now filled with. A selected disabled row drops back to Window with the
   dictionary's plain ButtonText foreground, and its indicator to GrayText.

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
