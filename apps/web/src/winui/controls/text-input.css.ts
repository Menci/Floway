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
// The rest stroke needs no rule at all: Fluent paints the root's four sides
// from colorNeutralStroke1 and overrides the bottom with
// colorNeutralStrokeAccessible, which the foundation layer maps to
// ControlStrokeColorDefault and ControlStrongStrokeColorDefault — precisely how
// TextControlElevationBorderBrush resolves once its ScaleY="-1" puts the heavy
// stop at the bottom. Any declaration on the root would also outrank Fluent's
// focus and aria-invalid strokes.
//
// What is left is written as redefinition of the Fluent variables that only the
// disagreeing states read, so Fluent's own atoms keep deciding which state
// wins. That is what keeps a disabled field disabled under the pointer and
// leaves the red aria-invalid stroke standing — a stroke WinUI has no
// counterpart for, and which stands here unsettled rather than sourced.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L48-L56
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L155-L163
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-input/library/src/components/Input/useInputStyles.styles.ts#L186-L201
//
// Fill is the exception: Fluent has no atom that recolours a text control's
// fill on hover or focus, and its disabled atom empties the fill rather than
// recolouring it, so those three states are written as declarations. A
// declaration cannot pick its variant the way a redefined variable does, so each
// is narrowed by `data-winui-appearance` to the appearances whose rest fill is
// Fluent's Background1. The `underline` appearance stays transparent and
// `filled-darker` keeps its Background3 step, as they do at rest.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L179-L182
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-input/library/src/components/Input/useInputStyles.styles.ts#L186-L201
//
// A text control resolves Disabled over Focused over PointerOver over Normal,
// one state at a time. Every declaration below that belongs to a state either
// excludes the states that outrank it or says why they cannot reach it, because
// a CSS declaration wins on selector weight rather than on that order.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/core/native/text/Controls/TextBoxBase.cpp#L3548-L3570
//
// Forced colours are left to Fluent and to the user agent, which override every
// background-color and border-color here outright; the one literal Fluent states
// for that mode -- GrayText on the disabled stroke -- survives because the
// disabled stroke here is a redefined variable rather than a declaration.
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-input/library/src/components/Input/useInputStyles.styles.ts#L206-L208
//
// The rules below stop at the boundary of a subtree that opts out of the layer:
// the playground's hand-designed chat UI is frozen and built against Fluent's
// own control palette, so every declaration here would repaint it. See
// ../tokens.ts for the convention.

import { notOptedOut } from '../tokens';

const controlFillAppearances = `:is(\
[data-winui-appearance='outline'],\
[data-winui-appearance='filled-lighter'],\
[data-winui-appearance='filled-lighter-shadow'])`;

export const textInputCss = `
/* WinUI's own padding and border carry each control past its stated 32px floor
   to 33 for a text control and 34 for a ComboBox, using the WinUI 3 values from
   the controls dictionary rather than the framework's legacy generic.xaml
   (10,5,6,6 rather than 10,3,6,6, and a 1px rather than 2px border).

   One shared 34 is our choice, not something WinUI states: a row mixing an Input
   with a Combobox is the common case here, and two fields disagreeing by a pixel
   read as a defect. 34 rather than 33 because growing a field keeps its content
   on its neighbour's baseline where shrinking one would not. ./choice.css.ts and
   ./switch.css.ts take the same number so a whole form row aligns.

   Stated on the root rather than the inner control, because that is where
   Fluent's own floor sits and border-box makes it the whole of the field.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources.xaml#L10-L12
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L327
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L341
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L342
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/themes/generic.xaml#L96
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/themes/generic.xaml#L173-L175 */
.fui-Input.fui-Input${notOptedOut},
.fui-Combobox.fui-Combobox${notOptedOut} {
  min-height: 34px;
}

/* Redefining Background1 reaches exactly the appearances the state rules below
   name, because those are the ones whose atoms read it.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L23
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L130 */
.fui-Input.fui-Input${notOptedOut},
.fui-Textarea.fui-Textarea${notOptedOut} {
  --colorNeutralBackground1: var(--winui-control-fill-default);
}

/* Both states that outrank PointerOver are excluded in the selector: a disabled
   field, whose Fluent atom this declaration would otherwise outrank, and a
   focused one, whose fill below carries less weight than the disabled exclusion
   adds here.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L24
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L131
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L275-L290 */
.fui-Input.fui-Input${controlFillAppearances}:hover:not(:focus-within):not(:has(> .fui-Input__input:disabled))${notOptedOut},
.fui-Textarea.fui-Textarea${controlFillAppearances}:hover:not(:focus-within):not(:has(> .fui-Textarea__textarea:disabled))${notOptedOut} {
  background-color: var(--winui-control-fill-secondary);
}

/* A disabled field cannot take focus, so no exclusion is needed here.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L25
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L132
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L291-L300 */
.fui-Input.fui-Input${controlFillAppearances}:focus-within${notOptedOut},
.fui-Textarea.fui-Textarea${controlFillAppearances}:focus-within${notOptedOut} {
  background-color: var(--winui-control-fill-input-active);
}

/* A text control has no pressed state -- Pressed is the same state as Focused --
   so the second selector spends the same colour on the strip Fluent darkens when
   the pointer goes down inside an already-focused field. It is not a narrower
   repetition of the first: Fluent's own rule for the combination ties the first
   on weight, and only naming the combination outranks it. The colour is stated
   on the strip rather than on the token Fluent reads for it, so it cannot
   inherit into whatever a caller puts in the content slots.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L57-L65
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L164-L172
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/core/native/text/Controls/TextBoxBase.cpp#L3551-L3555
   https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-input/library/src/components/Input/useInputStyles.styles.ts#L109-L112
   https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-textarea/library/src/components/Textarea/useTextareaStyles.styles.ts#L86-L89 */
.fui-Input.fui-Input${notOptedOut}::after,
.fui-Input.fui-Input${notOptedOut}:focus-within:active::after,
.fui-Textarea.fui-Textarea${notOptedOut}::after,
.fui-Textarea.fui-Textarea${notOptedOut}:focus-within:active::after {
  border-bottom-color: var(--winui-accent-base);
}

/* Disabled keeps a fill where Fluent empties it to the transparent background.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L26
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L133
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L261-L263 */
.fui-Input.fui-Input${controlFillAppearances}:has(> .fui-Input__input:disabled)${notOptedOut},
.fui-Textarea.fui-Textarea${controlFillAppearances}:has(> .fui-Textarea__textarea:disabled)${notOptedOut} {
  background-color: var(--winui-control-fill-disabled);
}

/* WinUI hands PointerOver the same TextControlElevationBorderBrush it uses at
   rest, so the hover step is cancelled by pointing both Fluent hover strokes at
   the rest pair.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L28
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L48-L56
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L135
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L155-L163 */
.fui-Input.fui-Input${notOptedOut},
.fui-Textarea.fui-Textarea${notOptedOut} {
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
.fui-Input.fui-Input${notOptedOut},
.fui-Textarea.fui-Textarea${notOptedOut} {
  --colorNeutralStrokeAccessiblePressed: var(--winui-control-stroke-default);
}

/* One step lighter than the dedicated disabled stroke the foundation installs
   for the rest of the library.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L30
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L137
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L264-L266 */
.fui-Input.fui-Input${notOptedOut},
.fui-Textarea.fui-Textarea${notOptedOut} {
  --colorNeutralStrokeDisabled: var(--winui-control-stroke-default);
}

/* WinUI holds the placeholder one step more prominent than Fluent's Foreground4
   through hover and focus; its disabled step already arrives through Fluent's
   own disabled atom on the inner control.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L35-L38
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L142-L145 */
.fui-Input.fui-Input${notOptedOut},
.fui-Textarea.fui-Textarea${notOptedOut} {
  --colorNeutralForeground4: var(--winui-text-fill-secondary);
}

/* The affordances flanking the field take the colour WinUI gives the control's
   own inner buttons. Their hover and pressed steps stay with whatever component
   a caller puts in the slot, and their disabled step stays with Fluent, whose
   atom on the slot outranks this redefinition. Textarea has no such slots.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L45
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L152 */
.fui-Input.fui-Input${notOptedOut} {
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
.fui-Input__input.fui-Input__input:disabled${notOptedOut},
.fui-Textarea__textarea.fui-Textarea__textarea:disabled${notOptedOut} {
  color: var(--winui-temporary-text-fill-disabled);
}

`;
