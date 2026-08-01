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

   The length is our own. The presenter sizes the bar by
   MAX(16, itemHeight - 40), which on this 40px row is a flat 16px; we take a
   quarter inset at each end instead -- 20px here -- so the bar holds its
   proportion as the row height changes rather than sitting short in a tall row.
   ./select.css.ts states the same quarter inset on a ComboBoxItem.
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
   from its own centre. Departure is the fade alone: WinUI registers no scale key frame on deselect
   and destroys the rectangle once the 83ms is up, so the height snaps back
   after the fade rather than shrinking with it. The bar therefore lives on
   every row and carries its state in its values, not in whether it exists.

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

/* The same arrival as key frames. The metric strip in
   ../../components/usage/summary-metrics.tsx gates its own copy of this bar on
   [aria-pressed], so its pseudo-element comes into being with the selection and
   has no rest values to transition from; an animation is what it can run. The
   shape is stated once, here, beside the control it belongs to. */
@keyframes winui-selection-indicator-fade {
  from { opacity: 0; }
}

@keyframes winui-selection-indicator-grow {
  from { scale: 1 0; }
}

/* Disablement. Fluent only softens the cursor; WinUI drops ContentBorder -- the
   row's fill and its content together -- to 0.3, which is the whole of what
   this sheet paints, so one opacity on the item carries it.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L6
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L381 */
.fui-ListItem.fui-ListItem[aria-disabled='true'] {
  opacity: 0.3;
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
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L29-L30
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L248
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L250
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L252
   https://github.com/microsoft/microsoft-ui-xaml/blob/543310634592831f8f2638301ece05d2d2dbea39/src/dxaml/xcp/components/FocusRect/FocusRectManager.cpp#L173-L174
   https://github.com/microsoft/microsoft-ui-xaml/blob/543310634592831f8f2638301ece05d2d2dbea39/src/dxaml/xcp/components/FocusRect/FocusRectManager.cpp#L718 */
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

/* The selection checkbox. Its fills, strokes and glyph belong to ./choice.css,
   which restyles every Checkbox; the corner radius is the one measure
   ListViewItem states for its own check box, and it is a pixel wider than the
   radius Fluent's indicator reset carries.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L59 */
.fui-ListItem__checkmark .fui-Checkbox__indicator.fui-Checkbox__indicator {
  border-radius: 3px;
}
`;
