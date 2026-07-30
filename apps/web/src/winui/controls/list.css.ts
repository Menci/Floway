// List and ListItem, restyled from the Fluent 2 Web look to WinUI 3. Fluent's
// list is a headless one: the item carries a list reset, a focus ring, and a
// cursor, and nothing else — no fill, no radius, no state. WinUI paints all of
// that in ListViewItemPresenter, so every rule below adds a state rather than
// replacing a Fluent value.
//
// The presenter is native code, so the theme dictionary states its brushes,
// radii and item metrics but nothing about its internal geometry; the
// selection indicator is the part that costs, and it is declined at its rule.
//
// Interaction states are keyed off `[tabindex]`, which useListItem gives an
// item exactly when selection or navigation makes it interactive, so a plain
// content row keeps the flat look Fluent gives it. Selection and disablement
// come from `aria-selected` and `aria-disabled`, which the same hook writes
// whenever the list runs in a selection mode. See ./tokens.ts for the selector
// convention.
export const listCss = `
/* The item body. WinUI rounds the row and holds it to the list's item height;
   Fluent leaves both to the consumer. The rest fill is
   SubtleFillColorTransparent, which is what an undeclared background already
   paints. ListViewItemForeground is TextFillColorPrimary, which is where the
   theme layer already points colorNeutralForeground1, so a foreground rule
   here would only restate it — the same reason ./text.css declines one.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L14
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L17
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L23
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L58 */
.fui-ListItem.fui-ListItem {
  min-height: 40px;
  border-radius: var(--winui-control-corner-radius);
}

/* WinUI's item padding (16,0,12,0) and MinWidth (88) are left out. Fluent
   declares neither, so each call site sizes its own row, and the min width
   belongs to the horizontally arranged form of the list rather than the stacked
   one this app uses.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L241 */

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
   on a 3px bar. The length is not stated for a ListViewItem, but WinUI marks a
   selected NavigationViewItem with the same bar and states 16 there; one
   selection indicator, described once.

   That 16 is stated against a 36px row, so it is carried here as the inset it
   leaves -- ten pixels at each end -- rather than as a length. A list row here
   sizes itself to its own content and runs well past 36, and a fixed 16 on a
   tall row reads as a tick beside it instead of a mark down its edge.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L57
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L60
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L75-L78
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L220-L222 */
.fui-ListItem.fui-ListItem[aria-selected='true'] {
  position: relative;
}

.fui-ListItem.fui-ListItem[aria-selected='true']::before {
  content: '';
  position: absolute;
  inset-inline-start: 0;
  inset-block: 10px;
  inline-size: 3px;
  border-radius: 1.5px;
  background-color: var(--winui-accent-fill-default);
}

/* Disablement. Fluent only softens the cursor; WinUI drops ContentBorder — the
   row's fill and its content together — to 0.3, which is the whole of what
   this sheet paints, so one opacity on the item carries it.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L6
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L381 */
.fui-ListItem.fui-ListItem[aria-disabled='true'] {
  opacity: 0.3;
}

/* Focus. Fluent's ring is a single 2px outline in --colorStrokeFocus2 at a
   radius the item already shares with WinUI, so retinting that token gives the
   outer stroke and the inner one is an inset shadow, the item having no border
   of its own to carry a second ring.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L29-L30
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L250
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L252

   The ring is pulled a pixel inside the row. Rows in a list carry no margin --
   WinUI states none, and the 4px corner is meant to show only on the row the
   pointer or the selection is on -- so a ring drawn on the border box lands
   exactly on the boundary it shares with the row above. FocusVisualMargin is
   the thickness WinUI keeps between the two.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L248 */
.fui-ListItem.fui-ListItem[data-fui-focus-visible] {
  --colorStrokeFocus2: var(--winui-focus-stroke-outer);
  box-shadow: inset 0 0 0 1px var(--winui-focus-stroke-inner);
  outline-offset: -1px;
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
