// Table and DataGrid restyled from Fluent 2 Web onto WinUI 3.
//
// WinUI 3 ships no data grid, so the row's counterpart is the ListViewItem:
// transparent at rest, moving through SubtleFillColorSecondary and Tertiary
// under the pointer, and marking selection with a fill plus a leading accent
// pill rather than a replaced surface and a four-edge stroke. The pointer ramp
// arrives through the theme, whose subtle background tokens already carry those
// two fills, so what is left here is what a token substitution cannot say.
//
// DataGrid, DataGridBody, DataGridRow, DataGridCell, DataGridHeader and
// DataGridHeaderCell each call the matching Table style hook and then only
// append their own class name, so the rules below name the Table classes and
// the DataGrid inherits them. The one place a DataGrid class is the subject is
// the selection pill, which needs `aria-selected` — an attribute only the
// DataGrid row writes.
export const tableCss = `
/* Row foreground under the pointer. WinUI resolves the item's normal,
   pointer-over and pressed foregrounds to one brush, so the text never moves,
   while Fluent walks its neutral ramp on hover and press. The rest state is
   Fluent's own and stays untouched; only the two moving states are pinned
   back to it.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L23-L25
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L88 */
.fui-TableRow.fui-TableRow:hover,
.fui-TableRow.fui-TableRow:active {
  color: var(--winui-text-fill-primary);
}

/* Only one element in a header may paint the pointer fill. A sortable header
   cell nests a button inside the cell, and Fluent gives both of them the same
   interactive fill; a header row carries it too. While that token was an opaque
   grey the inner fill simply replaced the outer, so the stack was invisible.
   WinUI's fill is translucent, so they composite instead, and a hovered header
   reads as a band with a darker block inside it -- which is why only sortable
   headers show it, since only they render the button.

   The cell keeps the fill, because the cell is what the pointer is over and
   what a click acts on. The row gives it up for the same reason a
   ListViewHeaderItem declares no pointer states at all, and the button gives it
   up because it is the cell's own interior.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L17-L25 */
.fui-TableHeader .fui-TableRow.fui-TableRow:hover,
.fui-TableHeader .fui-TableRow.fui-TableRow:active,
.fui-TableHeaderCell .fui-TableHeaderCell__button.fui-TableHeaderCell__button:hover,
.fui-TableHeaderCell .fui-TableHeaderCell__button.fui-TableHeaderCell__button:active {
  background-color: var(--winui-subtle-fill-transparent);
}

/* The rule between rows. Fluent's neutral stroke gives way to WinUI's divider
   brush; the edge itself is Fluent's, since a ListView draws no separator and a
   table without one is unreadable. Only the colour is stated, so the sizes that
   declare no bottom edge keep none.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L143
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L347 */
.fui-TableRow.fui-TableRow {
  border-bottom-color: var(--winui-divider-stroke-default);
}

/* Focus indicator. Fluent draws one 2px ring on the row, the cell, the
   selection cell and the header cell, all four out of one focus-stroke token.
   Only the ring's own colour is restated rather than that token, so a Button,
   Link or Menu trigger rendered inside a cell keeps the same ring it draws
   outside the table. The ring takes WinUI's outer focus stroke, the only one
   of its two strokes a single ring can carry; the header cell keys its ring
   off the focus landing anywhere inside it, the other three off the element
   itself. Fluent's outline carries no offset, so it sits directly against the
   border box and WinUI's inner ring goes inside it as an inset shadow, as on
   every other item-shaped surface in the layer.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L29
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L144
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L348 */
.fui-TableRow.fui-TableRow[data-fui-focus-visible],
.fui-TableCell.fui-TableCell[data-fui-focus-visible],
.fui-TableSelectionCell.fui-TableSelectionCell[data-fui-focus-visible],
.fui-TableHeaderCell.fui-TableHeaderCell[data-fui-focus-within]:focus-within {
  box-shadow: inset 0 0 0 1px var(--winui-focus-stroke-inner);
  outline-color: var(--winui-focus-stroke-outer);
}

/* Selection. The DataGrid's default selection appearance is \`brand\`, which
   replaces the row's surface and strokes all four of its edges; WinUI stays on
   the same subtle ramp it uses for the pointer and lets a leading accent pill
   carry the meaning, so only the fill is restated here — the stroke colours
   Fluent's appearance sets land on edges that carry no width, and the row keeps
   the divider below it. Each of the three fills is stated because Fluent moves
   a selected row under the pointer too: its interactive atoms outrank the
   appearance's.

   Selection reaches the DOM only as \`aria-selected\`, which the DataGrid row
   writes; the appearance prop a plain Table row takes never does.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L20 */
.fui-TableBody .fui-DataGridRow.fui-DataGridRow[aria-selected='true'] {
  background-color: var(--winui-subtle-fill-secondary);
}

/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L21 */
.fui-TableBody .fui-DataGridRow.fui-DataGridRow[aria-selected='true']:hover {
  background-color: var(--winui-subtle-fill-tertiary);
}

/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L22 */
.fui-TableBody .fui-DataGridRow.fui-DataGridRow[aria-selected='true']:active {
  background-color: var(--winui-subtle-fill-secondary);
}

/* WinUI's selection indicator is not restated here. It exists because a
   ListViewItem has nothing else to mark selection with; these rows carry a
   selection control in their first cell, which says the same thing in the
   place a reader already looks for it. */

/* Sortable header cell. Its label walks the same neutral ramp the row's does,
   and takes the same answer: WinUI holds one foreground across normal,
   pointer-over and pressed. \`aria-sort\` is written exactly when the cell is
   sortable, which keeps this off the header cells that do not respond to a
   click.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L23-L25 */
.fui-TableHeaderCell.fui-TableHeaderCell[aria-sort]:hover,
.fui-TableHeaderCell.fui-TableHeaderCell[aria-sort]:active {
  color: var(--winui-text-fill-primary);
}
`;
