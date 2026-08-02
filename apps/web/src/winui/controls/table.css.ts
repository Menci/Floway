export const tableCss = `
/* WinUI resolves the item's normal, pointer-over and pressed foregrounds to one
   brush, so only the two moving states are pinned back to Fluent's rest value.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L23-L25
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L88 */
.fui-TableRow.fui-TableRow:hover,
.fui-TableRow.fui-TableRow:active {
  color: var(--winui-text-fill-primary);
}

/* WinUI states no weight for any header-shaped item, so semibold is the
   dashboard's own choice.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/themes/generic.xaml#L9448-L9456 */
.fui-TableHeaderCell.fui-TableHeaderCell {
  font-weight: var(--fontWeightSemibold);
}

/* Stated on the nested button rather than inherited, because Fluent's button
   reset pins the leading to normal and a header that wraps would otherwise sit
   on a different leading from the cells beside it. */
.fui-TableHeaderCell__button.fui-TableHeaderCell__button {
  line-height: var(--lineHeightBase300);
}

/* The button slot declares \`background-color: inherit\`, and WinUI's cell fill
   is translucent, so the two composite into a band with a darker block inside
   it. The button gives the fill up in every state, not just the two the pointer
   names: the inherited value is wrong wherever the cell has one, including the
   horizontal padding the button does not cover.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L17-L25 */
.fui-TableHeaderCell .fui-TableHeaderCell__button.fui-TableHeaderCell__button {
  background-color: var(--winui-subtle-fill-transparent);
}

/* The edge itself is Fluent's, since a ListView draws no separator. Only the
   colour is stated, so the sizes that declare no bottom edge keep none.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L143
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L347 */
.fui-TableRow.fui-TableRow {
  border-bottom-color: var(--winui-divider-stroke-default);
}

/* The ring's own colour is restated rather than Fluent's focus-stroke token, so
   a Button, Link or Menu trigger inside a cell keeps the ring it draws outside
   the table.

   Both strokes are drawn inside the element's bounds: every table here sits in
   a rounded clipping host that would cut an offsetless outline, so pulling it
   in by the primary thickness seats the pair inside the clip, with the inner
   stroke riding the remainder of the focus visual's depth. Insetting the host
   instead is wrong at both ends -- the performance table has to meet its host's
   rounded border, and a gutter in the API key table would stop the row's fill
   short of the card edge.

   Under forced colours the user agent drops the inset shadow and forces the
   outline onto CanvasText, so no colour is needed there.
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
  box-shadow: inset 0 0 0 var(--winui-focus-visual-depth) var(--winui-focus-stroke-inner);
  outline-color: var(--winui-focus-stroke-outer);
  outline-offset: calc(-1 * var(--winui-focus-visual-primary-thickness));
}

/* Fluent's selected-row appearance replaces the row's surface; WinUI stays on
   the subtle ramp it uses for the pointer. The fill and foreground are restated
   on all three states a selected row can be in, since Fluent's interactive
   atoms outrank the appearance's.

   A row can be marked selected two independent ways -- aria-selected, which a
   DataGrid row also carries, and the appearance prop, which reaches the DOM
   only through the stamp ../appearance.ts writes -- and Fluent paints a brand
   or neutral appearance from its own ramps either way. Both are named here, in
   an :is so the rules keep the weight they had.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L20
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L26-L28 */
.fui-TableBody .fui-TableRow.fui-TableRow:is([aria-selected='true'], [data-winui-appearance='brand'], [data-winui-appearance='neutral']) {
  background-color: var(--winui-subtle-fill-secondary);
  color: var(--winui-text-fill-primary);
}

/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L21 */
.fui-TableBody .fui-TableRow.fui-TableRow:is([aria-selected='true'], [data-winui-appearance='brand'], [data-winui-appearance='neutral']):hover {
  background-color: var(--winui-subtle-fill-tertiary);
}

/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L22 */
.fui-TableBody .fui-TableRow.fui-TableRow:is([aria-selected='true'], [data-winui-appearance='brand'], [data-winui-appearance='neutral']):active {
  background-color: var(--winui-subtle-fill-secondary);
}

/* WinUI's leading selection indicator is deliberately not restated: it exists
   because a ListViewItem has nothing else to mark selection with, while these
   rows carry a selection control in their first cell. */

/* WinUI's text styles all wrap, and XAML's TextWrapping="Wrap" breaks inside a
   word when the word alone overruns the line -- WrapWholeWords is the opt-in
   that does not. A cell here holds a name its operator chose and ids a server
   returned, so the word that overruns is the common case, and a table track
   keeps an unbroken word as its automatic minimum size: without this the column
   widens past the table instead of wrapping in it. A cell that trims rather
   than wraps declares \`white-space: nowrap\`, which leaves no wrap opportunity
   for this to take.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBlock_themeresources.xaml#L15
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/core/text/RichTextServices/TextFormatter/LsTextLine.cpp#L1093-L1098
   https://drafts.csswg.org/css-text-4/#overflow-wrap-property */
.fui-TableCell.fui-TableCell {
  overflow-wrap: anywhere;
}

/* WinUI holds one foreground across normal, pointer-over and pressed.
   \`aria-sort\` is written exactly when the cell is sortable, which keeps this
   off the header cells that do not respond to a click.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L23-L25 */
.fui-TableHeaderCell.fui-TableHeaderCell[aria-sort]:hover,
.fui-TableHeaderCell.fui-TableHeaderCell[aria-sort]:active {
  color: var(--winui-text-fill-primary);
}

/* Every pointer and selection fill on a ListViewItem collapses onto Highlight
   with a HighlightText foreground. Fluent's own answer is a single-class atom
   that the pinned foreground above outranks, so without this the row would lose
   its one forced-colours state rather than gain WinUI's. The header needs none:
   forced colours repaints every \`color\` it reaches onto CanvasText, and the
   check box in a selection cell keeps Fluent's drawing, for the reason
   ./choice.css.ts writes down for every check box.

   A media query carries no specificity, so each selector repeats the shape of
   the rule it answers.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L83-L93
   https://drafts.csswg.org/css-color-adjust/#forced-colors-properties */
@media (forced-colors: active) {
  .fui-TableBody .fui-TableRow.fui-TableRow:hover,
  .fui-TableBody .fui-TableRow.fui-TableRow:active,
  .fui-TableBody .fui-TableRow.fui-TableRow:is([aria-selected='true'], [data-winui-appearance='brand'], [data-winui-appearance='neutral']),
  .fui-TableBody .fui-TableRow.fui-TableRow:is([aria-selected='true'], [data-winui-appearance='brand'], [data-winui-appearance='neutral']):hover,
  .fui-TableBody .fui-TableRow.fui-TableRow:is([aria-selected='true'], [data-winui-appearance='brand'], [data-winui-appearance='neutral']):active {
    background-color: Highlight;
    color: HighlightText;
  }
}
`;
