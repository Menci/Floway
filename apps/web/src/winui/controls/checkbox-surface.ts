// The WinUI check box's surface table, shared by every slot in this layer that
// draws one. WinUI defines the brushes once, on CheckBox itself, and a control
// that embeds a check box takes them whole; the slot differs, the table does
// not.
//
// An unchecked box is a cavity: the outline holds ControlStrongStrokeColorDefault
// across rest and pointer-over while the interior washes one step further down
// the alt-fill ramp per state, where Fluent leaves it transparent throughout.
// Selecting the box swaps the roles -- fill and stroke become the same accent
// brush per state, so it reads as a filled square with no outline of its own,
// and the glyph rides the on-accent ramp. Indeterminate takes the selected rows
// with Checked and differs only in the mark it draws, where Fluent instead
// leaves the indeterminate box hollow.
//
// Disabled keeps the shape rather than flattening it to a neutral, as Fluent
// does: the stroke and the glyph take their disabled steps whatever the box
// holds, the selected fill desaturates, and the unchecked cavity empties
// outright -- the disabled step is the one alt-fill step that is fully
// transparent.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L41-L72
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L217-L252

/**
 * States the table for one slot. Each field is the selector list naming that
 * slot in that state, so a caller carries only how its own control spells the
 * state -- an input's pseudo-classes, an option's ARIA attributes -- and the
 * brushes stay in one place.
 *
 * Pointer-over and disabled restate only what moves: the rest rows already
 * match those states and carry the rest of the row.
 *
 * The colours belong under `@media not (forced-colors: active)`, which the
 * caller opens: an accent-filled indicator under forced colours would need
 * forced-color-adjust: none, which this layer chooses not to take on, so forced
 * colours keeps Fluent's own drawing.
 */
export const checkboxSurfaceCss = (boxes: {
  unchecked: string;
  uncheckedHovered: string;
  uncheckedPressed: string;
  uncheckedDisabled: string;
  selected: string;
  selectedHovered: string;
  selectedPressed: string;
  disabled: string;
  selectedDisabled: string;
}) => `
/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L217-L218
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L229 */
${boxes.unchecked} {
  background-color: var(--winui-control-alt-fill-secondary);
  border-color: var(--winui-control-strong-stroke-default);
}

/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L230 */
${boxes.uncheckedHovered} {
  background-color: var(--winui-control-alt-fill-tertiary);
}

/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L219
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L231 */
${boxes.uncheckedPressed} {
  background-color: var(--winui-control-alt-fill-quarternary);
  border-color: var(--winui-control-strong-stroke-disabled);
}

/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L232 */
${boxes.uncheckedDisabled} {
  background-color: var(--winui-control-alt-fill-disabled);
}

/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L221
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L225
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L233
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L237
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L245
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L249 */
${boxes.selected} {
  background-color: var(--winui-accent-fill-default);
  border-color: var(--winui-accent-fill-default);
  color: var(--winui-text-on-accent-fill-primary);
}

/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L222
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L226
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L234
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L238 */
${boxes.selectedHovered} {
  background-color: var(--winui-accent-fill-secondary);
  border-color: var(--winui-accent-fill-secondary);
}

/* Pressed also drops the glyph one step down the on-accent ramp, which no other
   state of the check box does.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L223
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L227
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L235
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L239
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L247
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L251 */
${boxes.selectedPressed} {
  background-color: var(--winui-accent-fill-tertiary);
  border-color: var(--winui-accent-fill-tertiary);
  color: var(--winui-text-on-accent-fill-secondary);
}

/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L220
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L224
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L228
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L244
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L248
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L252 */
${boxes.disabled} {
  border-color: var(--winui-control-strong-stroke-disabled);
  color: var(--winui-text-on-accent-fill-disabled);
}

/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L236
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L240 */
${boxes.selectedDisabled} {
  background-color: var(--winui-accent-fill-disabled);
}
`;
