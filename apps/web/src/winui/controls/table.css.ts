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
//
// Windows High Contrast is transcribed at the end rather than handed back to
// Fluent, for the same reason ./list.css writes it out: the HighContrast
// dictionary collapses every pointer and selection fill onto Highlight with a
// HighlightText foreground, where Fluent's headless answer for a row is a
// Highlight foreground on hover alone. The check box in a selection cell keeps
// Fluent's forced-colours drawing, for the reason ./choice.css writes down for
// every check box.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L83-L93
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

/* A column header is told apart from the rows below it by weight. WinUI ships
   no data grid, and the one header-shaped item it does state --
   ListViewHeaderItem, a group caption rather than a column label -- sets no
   weight at all, so there is nothing here to transcribe: semibold is the
   dashboard's own choice, taken once for every table.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/themes/generic.xaml#L9448-L9456

   The weight is stated on the cell alone, which the button slot a sortable
   header nests inside it inherits. The leading has to be stated on that button
   instead, because Fluent's button reset pins it to normal, and a header that
   wraps would otherwise sit on a different leading from the cells beside it.
   Weight and leading are all this states, so the pointer, press, sort and focus
   states the rules below draw are left to them. */
.fui-TableHeaderCell.fui-TableHeaderCell {
  font-weight: var(--fontWeightSemibold);
}

.fui-TableHeaderCell__button.fui-TableHeaderCell__button {
  line-height: var(--lineHeightBase300);
}

/* The pointer fill inside a header. Fluent puts the hover and pressed fill on
   the header cell, and only when the column is sortable; the header row is
   never given the interactive ramp at all. The button slot the cell nests
   declares \`background-color: inherit\`, so it repaints whatever the cell
   resolved to. While that token was an opaque grey the repaint was invisible.
   WinUI's fill is translucent, so the two composite instead, and a hovered
   sortable header reads as a band with a darker block inside it.

   The cell keeps the fill, because the cell is what the pointer is over and
   what a click acts on. The button gives it up in every state rather than only
   the two the pointer names: the inherited value is wrong wherever the cell has
   one, including the horizontal padding the button does not cover, where the
   cell is hovered and the button is not.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L17-L25 */
.fui-TableHeaderCell .fui-TableHeaderCell__button.fui-TableHeaderCell__button {
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
   itself.

   Both strokes are drawn inside the element's own bounds. Fluent's outline
   carries no offset of its own, which would seat it against the border box,
   and a table has none to spare there: every table in the dashboard sits in a
   rounded clipping host, so a header cell would lose the ring's top edge and a
   body row -- which runs the host's full width -- its left and right. Pulling
   the outline in by the outer stroke's own 2px seats the pair inside that
   clip, and the inner stroke rides the third pixel of an inset shadow whose
   outer two the outline covers. WinUI reads the same way: a ListViewItem's
   focus rectangle is its bounds shrunk by FocusVisualMargin, never grown.
   Insetting the host instead is wrong at both ends -- the performance table
   has to meet its host's rounded border, and a gutter in the API key table
   would stop the row's own fill short of the card edge.

   Under forced colours the user agent drops that inset shadow and forces the
   outline onto CanvasText, which is that mode's reading of the WindowText the
   HighContrast dictionary states for the outer ring, so the ring keeps its
   geometry and needs no colour of its own there.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L29-L30
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L94
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L248
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L250
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L252
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L144
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L348
   https://github.com/microsoft/microsoft-ui-xaml/blob/543310634592831f8f2638301ece05d2d2dbea39/src/dxaml/xcp/components/FocusRect/FocusRectManager.cpp#L173-L174
   https://drafts.csswg.org/css-color-adjust/#forced-colors-properties */
.fui-TableRow.fui-TableRow[data-fui-focus-visible],
.fui-TableCell.fui-TableCell[data-fui-focus-visible],
.fui-TableSelectionCell.fui-TableSelectionCell[data-fui-focus-visible],
.fui-TableHeaderCell.fui-TableHeaderCell[data-fui-focus-within]:focus-within {
  box-shadow: inset 0 0 0 3px var(--winui-focus-stroke-inner);
  outline-color: var(--winui-focus-stroke-outer);
  outline-offset: -2px;
}

/* Selection. The DataGrid's default selection appearance is \`brand\`, which
   replaces the row's surface; WinUI stays on the same subtle ramp it uses for
   the pointer and lets a leading accent pill carry the meaning, so the fill is
   restated on all three of the states a selected row can be in -- Fluent moves
   a selected row under the pointer too, and its interactive atoms outrank the
   appearance's.

   The foreground goes with them. WinUI holds one brush across selected,
   selected pointer-over and selected pressed, which is the same brush it holds
   at rest; \`brand\` leaves the rest colour standing but \`neutral\` shifts it a
   step up the Fluent ramp, so stating it here is what makes the two appearances
   agree with WinUI and with each other.

   Both appearances also colour all four edges. Three of them carry no width;
   the bottom one is held by the divider rule above, which outranks them.

   Selection reaches the DOM only as \`aria-selected\`, which the DataGrid row
   writes; the appearance prop a plain Table row takes never does.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L20
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L26-L28 */
.fui-TableBody .fui-DataGridRow.fui-DataGridRow[aria-selected='true'] {
  background-color: var(--winui-subtle-fill-secondary);
  color: var(--winui-text-fill-primary);
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

/* High Contrast. Every pointer and selection fill on a ListViewItem collapses
   onto Highlight with a HighlightText foreground, so the body row takes that in
   all five of the states the rules above paint. Fluent states only a Highlight
   foreground on hover, out of a single-class atom that the pinned foreground
   above outranks, so without this the row would lose its one forced-colours
   state rather than gain WinUI's.

   The header's own pinned foreground needs no answer here, because the mode
   already produces the same one: forced colours repaints every \`color\` it
   reaches, so the header label's rest and hovered values both arrive at
   CanvasText, which is the one-foreground result the rule above states. The
   body row is the case that does need writing out, since Highlight against
   HighlightText is a pair the mode never arrives at on its own.

   A media query carries no specificity, so each selector repeats the shape of
   the rule it answers.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L83-L93
   https://drafts.csswg.org/css-color-adjust/#forced-colors-properties */
@media (forced-colors: active) {
  .fui-TableBody .fui-TableRow.fui-TableRow:hover,
  .fui-TableBody .fui-TableRow.fui-TableRow:active,
  .fui-TableBody .fui-DataGridRow.fui-DataGridRow[aria-selected='true'],
  .fui-TableBody .fui-DataGridRow.fui-DataGridRow[aria-selected='true']:hover,
  .fui-TableBody .fui-DataGridRow.fui-DataGridRow[aria-selected='true']:active {
    background-color: Highlight;
    color: HighlightText;
  }
}
`;
