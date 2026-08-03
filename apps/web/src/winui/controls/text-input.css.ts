// Fluent's Input and Textarea repainted as a WinUI 3 text control; WinUI's one
// shared TextControl* brush set covers both components.
//
// WinUI moves the FILL between rest, hover, focus and disabled while Fluent
// keeps the fill constant and moves the STROKE instead. So the rest stroke
// needs no rule at all: Fluent's colorNeutralStroke1 plus its
// colorNeutralStrokeAccessible bottom already resolve to what
// TextControlElevationBorderBrush paints, and any declaration on the root would
// outrank Fluent's focus stroke. The disagreeing states are written as
// redefinitions of the Fluent variables only those states read, so Fluent's own
// atoms keep deciding which state wins.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L48-L56
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L155-L163
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-input/library/src/components/Input/useInputStyles.styles.ts#L186-L201
//
// Fill is the exception: Fluent has no atom that recolours a text control's
// fill on hover or focus and its disabled atom empties the fill, so those three
// states are declarations. A declaration cannot pick its variant the way a
// redefined variable does, so each is narrowed by `data-winui-appearance` to
// the appearances whose rest fill is Background1, leaving `filled-darker` on
// its Background3 step.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L179-L182
//
// A text control resolves Disabled over Focused over PointerOver over Normal,
// one state at a time, while CSS wins on selector weight, so every state rule
// below excludes the states that outrank it or says why they cannot reach it.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/core/native/text/Controls/TextBoxBase.cpp#L3548-L3570
//
// Forced colours are left to Fluent and the user agent; the one literal Fluent
// states there -- GrayText on the disabled stroke -- survives only because the
// disabled stroke here is a redefined variable rather than a declaration.
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-input/library/src/components/Input/useInputStyles.styles.ts#L206-L208

const controlFillAppearances = `:is(\
[data-winui-appearance='outline'],\
[data-winui-appearance='filled-lighter'],\
[data-winui-appearance='filled-lighter-shadow'])`;

export const textInputCss = `
/* WinUI's padding and border carry a text control to 33 and a ComboBox to 34,
   using the WinUI 3 controls dictionary rather than the legacy generic.xaml.
   One shared 34 is our choice: a row mixing an Input with a Combobox is the
   common case, and growing a field keeps its content on its neighbour's
   baseline where shrinking one would not. ./choice.css.ts and ./switch.css.ts
   take the same number.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources.xaml#L10-L12
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L327
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L341
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L342
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/themes/generic.xaml#L96
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/themes/generic.xaml#L173-L175 */
.fui-Input.fui-Input,
.fui-Combobox.fui-Combobox {
  min-height: 34px;
}

/* Fluent reserves a 2px band at the bottom of a Textarea root so the browser's
   resize grip cannot sit on the focus strip. Our Textarea withholds the resize
   prop, so there is no grip, and the band would otherwise leave bare fill under
   the last line and carry the focus strip 2px further down than the strip of a
   single-line field standing on the same baseline. WinUI draws multi-line and
   single-line from the one TextBox template: one ScrollViewer filling
   BorderElement under a uniform TextControlThemePadding, no grip, and a focus
   underline that is the border's own bottom edge thickening.
   https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-textarea/library/src/components/Textarea/useTextareaStyles.styles.ts#L20-L22
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L194
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L296-L303
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L336-L337 */
.fui-Textarea.fui-Textarea {
  padding-bottom: 0;
}

/* Redefining Background1 reaches exactly the appearances the state rules below
   name, because those are the ones whose atoms read it.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L23
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L130 */
.fui-Input.fui-Input,
.fui-Textarea.fui-Textarea {
  --colorNeutralBackground1: var(--winui-control-fill-default);
}

/* Excludes both states that outrank PointerOver: a disabled field, whose Fluent
   atom this would otherwise outrank, and a focused one.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L24
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L131
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L275-L290 */
.fui-Input.fui-Input${controlFillAppearances}:hover:not(:focus-within):not(:has(> .fui-Input__input:disabled)),
.fui-Textarea.fui-Textarea${controlFillAppearances}:hover:not(:focus-within):not(:has(> .fui-Textarea__textarea:disabled)) {
  background-color: var(--winui-control-fill-secondary);
}

/* A disabled field cannot take focus, so no exclusion is needed here.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L25
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L132
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L291-L300 */
.fui-Input.fui-Input${controlFillAppearances}:focus-within,
.fui-Textarea.fui-Textarea${controlFillAppearances}:focus-within {
  background-color: var(--winui-control-fill-input-active);
}

/* A text control has no pressed state -- Pressed is Focused -- so the second
   selector respends the colour on the strip Fluent darkens when the pointer
   goes down inside a focused field; Fluent's rule for that combination ties the
   first selector on weight, so only naming the combination outranks it. Stated
   on the strip rather than the token Fluent reads, so it cannot inherit into
   whatever a caller puts in the content slots.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L57-L65
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L164-L172
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/core/native/text/Controls/TextBoxBase.cpp#L3551-L3555
   https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-input/library/src/components/Input/useInputStyles.styles.ts#L109-L112
   https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-textarea/library/src/components/Textarea/useTextareaStyles.styles.ts#L86-L89 */
.fui-Input.fui-Input::after,
.fui-Input.fui-Input:focus-within:active::after,
.fui-Textarea.fui-Textarea::after,
.fui-Textarea.fui-Textarea:focus-within:active::after {
  border-bottom-color: var(--winui-accent-base);
}

/* Disabled keeps a fill where Fluent empties it to the transparent background.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L26
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L133
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L261-L263 */
.fui-Input.fui-Input${controlFillAppearances}:has(> .fui-Input__input:disabled),
.fui-Textarea.fui-Textarea${controlFillAppearances}:has(> .fui-Textarea__textarea:disabled) {
  background-color: var(--winui-control-fill-disabled);
}

/* WinUI gives PointerOver the same brush as rest, so both Fluent hover strokes
   point back at the rest pair.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L28
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L48-L56
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L135
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L155-L163 */
.fui-Input.fui-Input,
.fui-Textarea.fui-Textarea {
  --colorNeutralStroke1Hover: var(--winui-control-stroke-default);
  --colorNeutralStrokeAccessibleHover: var(--winui-control-strong-stroke-default);
}

/* Focus flattens the stroke, the accent living only in the bottom gradient
   stop. Fluent reaches that state through its Pressed pair, and the foundation
   already gives colorNeutralStroke1Pressed the flat stroke, so only the
   accessible half is restated. The bottom edge needs no restatement: the accent
   strip above covers it while focused, including the compound brand colour
   Textarea alone puts there.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L29
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L57-L65
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L136
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L164-L172
   https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-textarea/library/src/components/Textarea/useTextareaStyles.styles.ts#L136-L139 */
.fui-Input.fui-Input,
.fui-Textarea.fui-Textarea {
  --colorNeutralStrokeAccessiblePressed: var(--winui-control-stroke-default);
}

/* One step lighter than the dedicated disabled stroke the foundation installs
   for the rest of the library.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L30
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L137
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L264-L266 */
.fui-Input.fui-Input,
.fui-Textarea.fui-Textarea {
  --colorNeutralStrokeDisabled: var(--winui-control-stroke-default);
}

/* A rejected value does not recolour the field. Shipped WinUI 3 has no
   field-level error affordance at all: the input-validation design is present
   in the dxaml templates, but the API is stripped from the release WinMD, the
   XAML compiler skips the INotifyDataErrorInfo bridge once that type probe
   fails, and the WinUI 3 dictionaries replace those templates with ones that
   carry no error state -- there is even a build target named
   DeleteInputValidate to scrub leftovers. Nothing under controls/dev assigns a
   SystemFill role to a BorderBrush in any state; InfoBar, the one shipped error
   surface, keeps the severity-neutral card stroke and says error in its fill,
   its icon and its text. So the message beside the field carries the state --
   ./field.css.ts paints it SystemFillColorCritical -- and the stroke holds its
   rest value, which is the redefinition below.

   The bottom edge cannot ride that redefinition: Fluent's invalid atom writes
   all four longhands from the one token, so the accessible bottom stroke is
   restated. It is guarded against the two states that outrank Invalid, and
   Fluent's own atom is likewise written against :not(:focus-within).
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/dll/Microsoft.UI.Xaml.Common.targets#L391
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/tools/UpdateThemeResources.ps1
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/inc/FeatureFlags.h#L20-L31
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/src/XamlCompiler/BuildTasks/CompileXamlInternal.cs#L1912
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L178
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBar/InfoBar_themeresources.xaml#L20
   https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-input/library/src/components/Input/useInputStyles.styles.ts#L163-L167 */
.fui-Input.fui-Input,
.fui-Textarea.fui-Textarea {
  --colorPaletteRedBorder2: var(--colorNeutralStroke1);
}

.fui-Input.fui-Input:has(> .fui-Input__input[aria-invalid='true']):not(:focus-within):not(:has(> .fui-Input__input:disabled)),
.fui-Textarea.fui-Textarea:has(> .fui-Textarea__textarea[aria-invalid='true']):not(:focus-within):not(:has(> .fui-Textarea__textarea:disabled)) {
  border-bottom-color: var(--colorNeutralStrokeAccessible);
}

/* WinUI holds the placeholder one step more prominent than Fluent's Foreground4
   through hover and focus; its disabled step already arrives through Fluent's
   own disabled atom on the inner control.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L35-L38
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L142-L145 */
.fui-Input.fui-Input,
.fui-Textarea.fui-Textarea {
  --colorNeutralForeground4: var(--winui-text-fill-secondary);
}

/* The affordances flanking the field take the colour WinUI gives the control's
   own inner buttons. Their hover and pressed steps stay with whatever component
   a caller puts in the slot, and their disabled step stays with Fluent, whose
   atom on the slot outranks this redefinition. Textarea has no such slots.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L45
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L152 */
.fui-Input.fui-Input {
  --colorNeutralForeground3: var(--winui-text-fill-secondary);
}

/* WinUI keys TextControlForegroundDisabled to TemporaryTextFillColorDisabled,
   one step off TextFillColorDisabled, splitting what Fluent reads from a single
   variable for both disabled text and disabled placeholder. The placeholder side
   is already right, so the text side is a declaration rather than a
   redefinition.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L34
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L141
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L145 */
.fui-Input__input.fui-Input__input:disabled,
.fui-Textarea__textarea.fui-Textarea__textarea:disabled {
  color: var(--winui-temporary-text-fill-disabled);
}

`;
