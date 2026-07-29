// Fluent's Input and Textarea repainted as a WinUI 3 text control. WinUI gives
// TextBox, RichEditBox and PasswordBox one shared brush set — the TextControl*
// keys — so a single mapping covers both Fluent components.
//
// Two differences drive the file. WinUI moves the FILL between rest, hover,
// focus and disabled while Fluent keeps it constant and moves the STROKE
// instead; and WinUI's rest stroke is one gradient brush whose heavy edge is
// the bottom, which Fluent already expresses as a separate border-bottom
// colour.
//
// The foundation layer carries most of the stroke and foreground work already:
// colorNeutralStroke1 is ControlStrokeColorDefault, colorNeutralStrokeAccessible
// is ControlStrongStrokeColorDefault, colorNeutralForeground1 is
// TextFillColorPrimary, and colorNeutralForegroundDisabled is
// TextFillColorDisabled. What is left is written the way button.css.ts writes
// it: as redefinition of the Fluent variables that only the disagreeing states
// read, so Fluent's own atoms keep deciding which state wins. That is what
// keeps a disabled field disabled under the pointer and leaves the red
// aria-invalid stroke — an affordance WinUI's text controls do not have —
// standing.
//
// Fill is the exception. Fluent has no atom that recolours a text control's
// fill on hover or focus, and its disabled atom empties the fill rather than
// recolouring it, so those three states are written as declarations, scoped
// one class above Griffel by `.fui-FluentProvider`.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L179-L182
export const textInputCss = `
/* Rest fill. Fluent leaves the control on the opaque neutral ramp; WinUI puts
   it on the translucent control fill. Redefining the variable rather than
   setting background-color keeps the transparent \`underline\` appearance
   transparent and leaves \`filled-darker\`, which reads Background3, alone.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L23
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L130 */
.fui-FluentProvider .fui-Input,
.fui-FluentProvider .fui-Textarea {
  --colorNeutralBackground1: var(--winui-control-fill-default);
}

/* Hover fill. Excluded on a disabled field, where WinUI's Disabled state wins
   over PointerOver and Fluent's disabled atom would otherwise be outranked by
   this declaration.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L24
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L131
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L256-L290 */
.fui-FluentProvider .fui-Input:hover:not(:has(> .fui-Input__input:disabled)),
.fui-FluentProvider .fui-Textarea:hover:not(:has(> .fui-Textarea__textarea:disabled)) {
  background-color: var(--winui-control-fill-secondary);
}

/* Focus lifts the fill to the opaque input colour. A disabled field cannot
   take focus, so no exclusion is needed here. The accent bottom edge of
   TextControlElevationBorderFocusedBrush is left to Fluent's own ::after
   strip — its colour is a Windows-generated system accent that no theme
   dictionary carries.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L25
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L132
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L291-L300 */
.fui-FluentProvider .fui-Input:focus-within,
.fui-FluentProvider .fui-Textarea:focus-within {
  background-color: var(--winui-control-fill-input-active);
}

/* Disabled keeps a fill where Fluent empties it to the transparent background.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L26
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L133
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L260-L262 */
.fui-FluentProvider .fui-Input:has(> .fui-Input__input:disabled),
.fui-FluentProvider .fui-Textarea:has(> .fui-Textarea__textarea:disabled) {
  background-color: var(--winui-control-fill-disabled);
}

/* Hover stroke. WinUI hands PointerOver the same TextControlElevationBorderBrush
   it uses at rest, so the hover step is cancelled by pointing both Fluent hover
   strokes at the rest pair the foundation already installs. The gradient's
   lower half is ControlStrongStrokeColorDefault and its upper half
   ControlStrokeColorDefault, which is exactly Fluent's border /
   border-bottom split.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L28
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L48-L56
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L135
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L155-L163 */
.fui-FluentProvider .fui-Input,
.fui-FluentProvider .fui-Textarea {
  --colorNeutralStroke1Hover: var(--winui-control-stroke-default);
  --colorNeutralStrokeAccessibleHover: var(--winui-control-strong-stroke-default);
}

/* Focus flattens the stroke: TextControlElevationBorderFocusedBrush is
   ControlStrokeColorDefault on every side, the accent living only in the
   bottom gradient stop. Fluent reaches that state through its Pressed pair —
   WinUI's text controls have no pressed state of their own — and the
   foundation already gives colorNeutralStroke1Pressed the flat stroke, so only
   the accessible half is restated here.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L29
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L57-L65
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L136
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L164-L172 */
.fui-FluentProvider .fui-Input,
.fui-FluentProvider .fui-Textarea {
  --colorNeutralStrokeAccessiblePressed: var(--winui-control-stroke-default);
}

/* Disabled drops the composed stroke to the ordinary control stroke on all
   four sides, one step lighter than the dedicated disabled stroke the
   foundation installs for the rest of the library.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L30
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L137
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L263-L265 */
.fui-FluentProvider .fui-Input,
.fui-FluentProvider .fui-Textarea {
  --colorNeutralStrokeDisabled: var(--winui-control-stroke-default);
}

/* Placeholder. WinUI sits one step brighter than Fluent's Foreground4 and
   holds that step through hover and focus; the disabled step is
   TextFillColorDisabled, which the foundation already gives
   colorNeutralForegroundDisabled.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L35-L38
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L142-L145 */
.fui-FluentProvider .fui-Input,
.fui-FluentProvider .fui-Textarea {
  --colorNeutralForeground4: var(--winui-text-fill-secondary);
}

/* The affordances flanking the field take the colour WinUI gives the control's
   own inner buttons, which is a step brighter than the Foreground3 they
   inherit. Textarea has no such slots.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L45
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L152 */
.fui-FluentProvider .fui-Input {
  --colorNeutralForeground3: var(--winui-text-fill-secondary);
}

/* Disabled text is left to the foundation's TextFillColorDisabled. WinUI keys
   it to TemporaryTextFillColorDisabled instead, a one-off that differs by a
   single unit per channel (#5DFEFEFE against #5DFFFFFF) and is not worth a
   variable of its own.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L22
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L34
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L129
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L141 */
`;
