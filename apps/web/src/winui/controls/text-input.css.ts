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
// TextFillColorDisabled. The first two are the whole rest stroke: Fluent already
// paints the root's four sides from colorNeutralStroke1 and overrides the bottom
// with colorNeutralStrokeAccessible, which is precisely how
// TextControlElevationBorderBrush resolves once its ScaleY="-1" puts the heavy
// ControlStrongStrokeColorDefault stop at the bottom. No rule here restates it,
// because any declaration on the root would also outrank Fluent's focus and
// aria-invalid strokes.
//
// What is left is written the way button.css.ts writes
// it: as redefinition of the Fluent variables that only the disagreeing states
// read, so Fluent's own atoms keep deciding which state wins. That is what
// keeps a disabled field disabled under the pointer and leaves the red
// aria-invalid stroke — an affordance WinUI's text controls do not have —
// standing.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L48-L56
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L155-L163
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-input/library/src/components/Input/useInputStyles.styles.ts#L186-L201
//
// Fill is the exception. Fluent has no atom that recolours a text control's
// fill on hover or focus, and its disabled atom empties the fill rather than
// recolouring it, so those three states are written as declarations, scoped
// one class above Griffel by `.fui-FluentProvider`. A declaration cannot pick
// its variant the way a redefined variable does, so each one is narrowed by
// `data-winui-appearance` to exactly the appearances whose rest fill is
// Fluent's Background1 — the ones the rest rule below moves onto the WinUI
// control fill. The `underline` appearance stays transparent and
// `filled-darker` keeps its Background3 step, as they do at rest.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L179-L182
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-input/library/src/components/Input/useInputStyles.styles.ts#L186-L201
const controlFillAppearances = `:is(\
[data-winui-appearance='outline'],\
[data-winui-appearance='filled-lighter'],\
[data-winui-appearance='filled-lighter-shadow'])`;

export const textInputCss = `
/* Rest fill. Fluent leaves the control on the opaque neutral ramp; WinUI puts
   it on the translucent control fill. Redefining Background1 reaches exactly
   the appearances the state rules below name, because those are the ones whose
   atoms read it.
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
.fui-FluentProvider .fui-Input${controlFillAppearances}:hover:not(:has(> .fui-Input__input:disabled)),
.fui-FluentProvider .fui-Textarea${controlFillAppearances}:hover:not(:has(> .fui-Textarea__textarea:disabled)) {
  background-color: var(--winui-control-fill-secondary);
}

/* Focus lifts the fill to the opaque input colour. A disabled field cannot
   take focus, so no exclusion is needed here. The accent bottom edge of
   TextControlElevationBorderFocusedBrush is still left to Fluent's own ::after
   strip: its heavy stop is SystemAccentColorDark1 in light and
   SystemAccentColorLight2 in dark, ramp steps Windows generates from the user
   accent that appear in no theme dictionary and carry no opacity relationship
   to a base we could substitute, so there is no value to transcribe.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L25
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L132
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L291-L300 */
.fui-FluentProvider .fui-Input${controlFillAppearances}:focus-within,
.fui-FluentProvider .fui-Textarea${controlFillAppearances}:focus-within {
  background-color: var(--winui-control-fill-input-active);
}

/* Disabled keeps a fill where Fluent empties it to the transparent background.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L26
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L133
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L260-L262 */
.fui-FluentProvider .fui-Input${controlFillAppearances}:has(> .fui-Input__input:disabled),
.fui-FluentProvider .fui-Textarea${controlFillAppearances}:has(> .fui-Textarea__textarea:disabled) {
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

/* Disabled text. WinUI keys TextControlForegroundDisabled to
   TemporaryTextFillColorDisabled, a near-neutral one step off the pure channel
   of TextFillColorDisabled. Fluent reads one variable for both the disabled
   text and the disabled placeholder, and WinUI splits them — the placeholder
   keeps TextFillColorDisabled, which the foundation already installs — so the
   text side is written as a declaration on the control element rather than as
   a redefinition.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L34
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L141
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L145 */
.fui-FluentProvider .fui-Input__input:disabled,
.fui-FluentProvider .fui-Textarea__textarea:disabled {
  color: var(--winui-temporary-text-fill-disabled);
}

/* Selection highlight. WinUI paints the band behind selected text with the
   accent; the glyphs over it take TextOnAccentFillColorSelectedText, white in
   both dictionaries, which the text control templates leave to the system
   rather than setting themselves.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L39
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L146
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L11
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L215 */
.fui-FluentProvider .fui-Input__input::selection,
.fui-FluentProvider .fui-Textarea__textarea::selection {
  background-color: var(--winui-accent-fill-selected-text-background);
  color: var(--winui-text-on-accent-fill-selected-text);
}
`;
