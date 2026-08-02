// Checkbox and Radio, restyled from the Fluent 2 Web look to WinUI 3.
//
// WinUI paints the selected state as a filled accent shape carrying a light
// glyph, where Fluent leaves the box hollow and tints the glyph itself. Border
// and glyph swap roles on selection, so the checked and indeterminate rules
// restate background, border and glyph together rather than adjusting one.
// The indicator element is painted directly rather than through Fluent's
// `--fui-Checkbox__indicator--*` custom properties, so one rule can cover the
// Fluent states sharing a single WinUI value.
//
// Colour is confined to `@media not (forced-colors: active)`: an accent-filled
// indicator under forced colours would need `forced-color-adjust: none`, which
// this layer chooses not to take on, so forced colours keeps Fluent's drawing.
// Geometry applies in both modes.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L92-L179
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L62-L119

// The tri-state check box is named by the data-winui-checked stamp
// ../appearance.ts applies, never by :indeterminate. The browser clears that
// property when the user activates the box, and Fluent re-asserts it only from
// an effect keyed on the mixed flag, which does not re-run while the box stays
// mixed -- so the property is gone for good on a box held at mixed while Fluent
// keeps painting it. Both halves are stated here and consumed by every rule
// that distinguishes the state, ./list.css.ts included, so no sheet can reach
// for the property again.
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-checkbox/library/src/components/Checkbox/useCheckbox.tsx#L163-L169
import { nested, pressedRoots, under } from './selectors';

export const checkboxMixed = "[data-winui-checked='mixed']";
export const checkboxNotMixed = `:not(${checkboxMixed})`;

const checkboxPressed = pressedRoots('.fui-Checkbox', '.fui-Checkbox__input');
const radioPressed = pressedRoots('.fui-Radio', '.fui-Radio__input');

const uncheckedBox = `.fui-Checkbox__input:enabled:not(:checked)${checkboxNotMixed}`
  + ` ~ .fui-Checkbox__indicator.fui-Checkbox__indicator`;

const selectedBoxes = [
  `.fui-Checkbox__input:enabled:checked ~ .fui-Checkbox__indicator.fui-Checkbox__indicator`,
  `.fui-Checkbox__input:enabled${checkboxMixed} ~ .fui-Checkbox__indicator.fui-Checkbox__indicator`,
];

const uncheckedEllipse = `.fui-Radio__input:enabled:not(:checked)`
  + ` ~ .fui-Radio__indicator.fui-Radio__indicator`;

const selectedEllipse = `.fui-Radio__input:enabled:checked`
  + ` ~ .fui-Radio__indicator.fui-Radio__indicator`;

const selectedDot = `${selectedEllipse}::after`;

export const choiceCss = `
/* Check box geometry. Fluent's check mark is an SVG carrying literal width and
   height attributes which no font size reaches, so the glyph is sized on the
   element itself. The corner radius has to be stated: Fluent's indicator reset
   reads \`borderRadiusSmall\`, which the theme layer leaves on Fluent's own 2px
   because no WinUI radius is that small -- and stating it means naming the
   square shape, since \`shape="circular"\` reads the same property.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L270-L271
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L294
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L603
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CornerRadius_themeresources.xaml#L13-L15 */
.fui-Checkbox__indicator.fui-Checkbox__indicator {
  width: 20px;
  height: 20px;
  /* WinUI centres the box in the control, where Fluent pins it to the top so
     it meets the first line of a wrapping label.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L602 */
  align-self: center;
  margin: 0;
}

.fui-Checkbox__indicator.fui-Checkbox__indicator > svg {
  width: 12px;
  height: 12px;
}

/* WinUI states eight pixels as the label's own offset rather than a surround on
   the indicator, so Fluent's indicator margin goes and the root spaces its own
   children -- which also holds when the label sits before, after or above the
   indicator.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L274
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L187 */
.fui-Checkbox.fui-Checkbox,
.fui-Radio.fui-Radio {
  align-items: center;
  gap: 8px;
}

/* With the indicator margins gone, Fluent's block padding is the last thing
   holding the root taller than what it draws. */
.fui-Checkbox__label.fui-Checkbox__label,
.fui-Radio__label.fui-Radio__label {
  padding: 0;
}

/* Fluent gives the radio in a table's selection cell no width of its own and
   relies on the intrinsic footprint of a 16px box plus the 8px margins removed
   above. Ours draws 20, so the box is pinned to that.
   https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-table/library/src/components/TableSelectionCell/useTableSelectionCellStyles.styles.ts#L9
   https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-table/library/src/components/TableSelectionCell/useTableSelectionCellStyles.styles.ts#L17-L31 */
.fui-TableSelectionCell__radioIndicator.fui-TableSelectionCell__radioIndicator {
  flex: none;
  width: 20px;
}

/* 34px is this dashboard's shared control-row height, deliberately two pixels
   over the 32 WinUI states, so these controls stand as tall as an ordinary field
   and align inside a form. A control carrying a label is a field and takes the
   row height; one without is a mark in a cell and is only itself.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L272
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L291
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L370 */
.fui-Checkbox.fui-Checkbox:has(> .fui-Checkbox__label),
.fui-Radio.fui-Radio:has(> .fui-Radio__label) {
  min-height: 34px;
}

.fui-Checkbox[data-winui-shape='square'] > .fui-Checkbox__indicator.fui-Checkbox__indicator {
  border-radius: var(--winui-control-corner-radius);
}

/* The input is the hit target, wider than the drawn box. */
.fui-Checkbox__input.fui-Checkbox__input {
  width: calc(20px + 2 * var(--spacingHorizontalS));
}

/* Focus ring stand-off. Both controls set a negative FocusVisualMargin of
   -7,-3, instead of Fluent's uniform 2px. It is a style setter rather than a
   theme resource, so the geometry holds in every theme, forced colours
   included; only the ring's colours below are gated.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L275
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L196 */
.fui-Checkbox.fui-Checkbox[data-fui-focus-within]:focus-within::after,
.fui-Radio.fui-Radio[data-fui-focus-within]:focus-within::after {
  top: -3px;
  right: -7px;
  bottom: -3px;
  left: -7px;
}

@media not (forced-colors: active) {
  /* WinUI holds the label at TextFillColorPrimary through every enabled state,
     where Fluent walks a three-step neutral ramp from rest to pressed.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L181-L183 */
  .fui-Checkbox.fui-Checkbox,
  .fui-Checkbox.fui-Checkbox:hover,
  .fui-Checkbox.fui-Checkbox:active {
    color: var(--winui-text-fill-primary);
  }

  /* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L184 */
  .fui-Checkbox__input:disabled ~ .fui-Checkbox__label.fui-Checkbox__label {
    color: var(--winui-text-fill-disabled);
  }

  /* Unchecked box. The outline holds ControlStrongStrokeColorDefault across
     rest and pointer-over, so one rule replaces Fluent's rest and hover pair,
     but the interior is a cavity that washes one step further down the alt-fill
     ramp per state, which Fluent leaves transparent throughout.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L217-L218
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L229 */
  .fui-Checkbox__input:enabled:not(:checked)${checkboxNotMixed}
    ~ .fui-Checkbox__indicator.fui-Checkbox__indicator {
    background-color: var(--winui-control-alt-fill-secondary);
    border-color: var(--winui-control-strong-stroke-default);
  }

  /* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L230 */
  .fui-Checkbox:hover
    .fui-Checkbox__input:enabled:not(:checked)${checkboxNotMixed}
    ~ .fui-Checkbox__indicator.fui-Checkbox__indicator {
    background-color: var(--winui-control-alt-fill-tertiary);
  }

  /* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L219
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L231 */
${nested(under(checkboxPressed, [uncheckedBox]))} {
    background-color: var(--winui-control-alt-fill-quarternary);
    border-color: var(--winui-control-strong-stroke-disabled);
  }

  /* The disabled cavity is the one alt-fill step that is fully transparent, so
     it is the unchecked box, not the checked one, that loses its interior.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L232 */
  .fui-Checkbox__input:disabled:not(:checked)${checkboxNotMixed}
    ~ .fui-Checkbox__indicator.fui-Checkbox__indicator {
    background-color: var(--winui-control-alt-fill-disabled);
  }

  /* Selected box. WinUI gives Indeterminate the same accent fill and stroke as
     Checked and differs only in the glyph it draws, so both states share these
     rules; Fluent instead leaves the indeterminate box hollow. Fill and stroke
     are the same accent brush per state, so the box reads as a filled square
     with no outline of its own.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L221
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L225
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L233
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L237
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L245
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L249 */
  .fui-Checkbox__input:enabled:checked ~ .fui-Checkbox__indicator.fui-Checkbox__indicator,
  .fui-Checkbox__input:enabled${checkboxMixed} ~ .fui-Checkbox__indicator.fui-Checkbox__indicator {
    background-color: var(--winui-accent-fill-default);
    border-color: var(--winui-accent-fill-default);
    color: var(--winui-text-on-accent-fill-primary);
  }

  /* The selected box walks the accent ramp on pointer-over and pressed, the
     same two steps for Checked and Indeterminate.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L222
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L226
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L234
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L238 */
  .fui-Checkbox:hover
    .fui-Checkbox__input:enabled:checked
    ~ .fui-Checkbox__indicator.fui-Checkbox__indicator,
  .fui-Checkbox:hover
    .fui-Checkbox__input:enabled${checkboxMixed}
    ~ .fui-Checkbox__indicator.fui-Checkbox__indicator {
    background-color: var(--winui-accent-fill-secondary);
    border-color: var(--winui-accent-fill-secondary);
  }

  /* Pressed also drops the glyph one step down the on-accent ramp, which no
     other state of the check box does.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L223
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L227
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L235
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L239
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L247
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L251 */
${nested(under(checkboxPressed, selectedBoxes))} {
    background-color: var(--winui-accent-fill-tertiary);
    border-color: var(--winui-accent-fill-tertiary);
    color: var(--winui-text-on-accent-fill-secondary);
  }

  /* Disabled. WinUI keeps the selected box accent-shaped and only desaturates
     it, and keeps the glyph on the on-accent ramp, where Fluent collapses every
     disabled check box onto one neutral appearance. The stroke is the disabled
     strong stroke whether the box is unchecked, checked or indeterminate, and
     so is the glyph's disabled on-accent colour, so one rule states both.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L220
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L224
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L228
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L244
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L248
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L252 */
  .fui-Checkbox__input:disabled ~ .fui-Checkbox__indicator.fui-Checkbox__indicator {
    border-color: var(--winui-control-strong-stroke-disabled);
    color: var(--winui-text-on-accent-fill-disabled);
  }

  /* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L236
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L240 */
  .fui-Checkbox__input:disabled:checked ~ .fui-Checkbox__indicator.fui-Checkbox__indicator,
  .fui-Checkbox__input:disabled${checkboxMixed} ~ .fui-Checkbox__indicator.fui-Checkbox__indicator {
    background-color: var(--winui-accent-fill-disabled);
  }

  /* Focus ring colours. WinUI's focus visual is two concentric rings -- an
     outer one in the text colour and an inner one in the surface colour -- so
     it stays legible over any fill, where Fluent draws a single accent-adjacent
     stroke. The inner ring is an inset shadow because it must sit inside the
     outer ring's own border box. The two ring thicknesses are the framework
     defaults, which this corpus states only where ListViewItem restates them.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L258-L259
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L250-L252 */
  .fui-Checkbox.fui-Checkbox[data-fui-focus-within]:focus-within::after {
    border-color: var(--winui-focus-stroke-outer);
    box-shadow: inset 0 0 0 1px var(--winui-focus-stroke-inner);
  }
}

/* Radio geometry. The outer ellipse is 20px and the checked dot is sized in
   absolute pixels per state -- 12 at rest, 14 on pointer-over, 10 while
   pressed -- so the dot's scale factor is that size over the 20px ellipse,
   replacing Fluent's single 0.625 of a 16px box. WinUI writes no size key frame
   for the return to rest, so shipped WinUI snaps the dot back; the transition is
   deliberately kept symmetric here.

   That symmetry is why the dot is generated unconditionally and rests at scale
   0, with the checked state carrying only the value. Fluent hangs the
   pseudo-element's \`content\` on \`:checked\`, which destroys the box on
   deselection and leaves the transition with nothing to run between.

   WinUI top-aligns the radio's indicator band while centring the check box's.
   The indicator is centred here for both, which is what the shared control row
   above asks for.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L371
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L179-L181
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L256
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L293
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L204-L227
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L370 */
.fui-Radio__indicator.fui-Radio__indicator {
  width: 20px;
  height: 20px;
  align-self: center;
  margin: 0;
}

.fui-Radio__indicator.fui-Radio__indicator::after {
  width: 20px;
  height: 20px;
  content: '';
  transform: scale(0);
  transition-duration: var(--winui-control-normal-animation-duration);
  transition-property: transform;
  transition-timing-function: var(--winui-control-fast-out-slow-in-easing);
}

.fui-Radio__input:checked ~ .fui-Radio__indicator.fui-Radio__indicator::after {
  transform: scale(0.6);
}

/* A departure from shipped WinUI, which keeps growing the dot under reduced
   motion: its growth is authored as a VisualState storyboard rather than a
   VisualTransition, and the animations-disabled gate reaches only Transition and
   Dynamic storyboards. A control that changes size is motion animation by WCAG's
   definition, which turns on perceived size and position, so the preference is
   about it whatever the framework's gate happens to reach.

   0.01ms rather than none, for the reason WinUI runs a disabled
   ConnectedAnimation for 1ms instead of zero: the completion still has to
   fire.
   https://www.w3.org/TR/WCAG21/#dfn-motion-animation
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L255-L259
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/components/vsm/VisualStateManagerActuator.cpp#L590-L609
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/components/animation/ConnectedAnimationService.cpp#L313-L327 */
@media (prefers-reduced-motion: reduce) {
  .fui-Radio__indicator.fui-Radio__indicator::after {
    transition-duration: 0.01ms;
  }
}

/* The same hit target as the check box above, on the ellipse. It is stated as a
   floor rather than a width because labelPosition="below" stacks the label under
   the ellipse and stretches the input to the full root width; a floor leaves
   that stretch intact. */
.fui-Radio__input.fui-Radio__input {
  min-width: calc(20px + 2 * var(--spacingHorizontalS));
}

/* Neutralizes Fluent's 2px pull, which assumes a 16px ellipse; at 20px it
   resolves to zero. */
.fui-Radio__label.fui-Radio__label {
  margin-top: calc((20px - var(--lineHeightBase300)) / 2);
  margin-bottom: calc((20px - var(--lineHeightBase300)) / 2);
}

/* Read off the root: pointer-over and pressed are states of the whole control
   in WinUI, while the input's box covers only the ellipse.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L180 */
.fui-Radio:hover
  .fui-Radio__input:enabled:checked
  ~ .fui-Radio__indicator.fui-Radio__indicator::after {
  transform: scale(0.7);
}

/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L181 */
${under(radioPressed, [selectedDot])} {
  transform: scale(0.5);
}

@media not (forced-colors: active) {
  /* WinUI holds the label at TextFillColorPrimary through every enabled state;
     the disabled label is left to Fluent, whose token already resolves to
     TextFillColorDisabled.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L122-L125 */
  .fui-Radio .fui-Radio__input:enabled ~ .fui-Radio__label.fui-Radio__label {
    color: var(--winui-text-fill-primary);
  }

  /* Unselected ellipse; WinUI washes the interior down the alt-fill ramp per
     state where Fluent leaves it transparent.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L134-L135
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L138 */
  .fui-Radio
    .fui-Radio__input:enabled:not(:checked)
    ~ .fui-Radio__indicator.fui-Radio__indicator {
    background-color: var(--winui-control-alt-fill-secondary);
    border-color: var(--winui-control-strong-stroke-default);
  }

  /* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L139 */
  .fui-Radio:hover
    .fui-Radio__input:enabled:not(:checked)
    ~ .fui-Radio__indicator.fui-Radio__indicator {
    background-color: var(--winui-control-alt-fill-tertiary);
  }

  /* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L136
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L140 */
${nested(under(radioPressed, [uncheckedEllipse]))} {
    background-color: var(--winui-control-alt-fill-quarternary);
    border-color: var(--winui-control-strong-stroke-disabled);
  }

  /* Selected ellipse. WinUI fills it with accent and lays the dot on top in the
     on-accent foreground, where Fluent keeps the ellipse hollow and paints the
     dot accent.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L142
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L146 */
  .fui-Radio .fui-Radio__input:enabled:checked ~ .fui-Radio__indicator.fui-Radio__indicator {
    background-color: var(--winui-accent-fill-default);
    border-color: var(--winui-accent-fill-default);
  }

  /* The selected ellipse walks the same accent ramp the selected check box
     does, in fill and stroke together.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L143
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L147 */
  .fui-Radio:hover
    .fui-Radio__input:enabled:checked
    ~ .fui-Radio__indicator.fui-Radio__indicator {
    background-color: var(--winui-accent-fill-secondary);
    border-color: var(--winui-accent-fill-secondary);
  }

  /* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L144
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L148 */
${nested(under(radioPressed, [selectedEllipse]))} {
    background-color: var(--winui-accent-fill-tertiary);
    border-color: var(--winui-accent-fill-tertiary);
  }

  /* The dot carries the accent elevation stroke over its accent surround, drawn
     as a border because that token is a three-term \`border-color\` no box-shadow
     can consume. Border-box sizing keeps the ring inside the 20px the scale
     factor above operates on.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L150
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L153
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L158-L160 */
  .fui-Radio .fui-Radio__indicator.fui-Radio__indicator::after {
    box-sizing: border-box;
    background-color: var(--winui-text-on-accent-fill-primary);
    border: 1px solid;
    border-color: var(--winui-accent-control-elevation-border-color);
  }

  /* Disabled. As with the check box, WinUI keeps the selected ellipse
     accent-shaped and desaturates it rather than flattening it to a neutral,
     and empties the unselected cavity outright.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L137
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L141 */
  .fui-Radio
    .fui-Radio__input:disabled:not(:checked)
    ~ .fui-Radio__indicator.fui-Radio__indicator {
    background-color: var(--winui-control-alt-fill-disabled);
    border-color: var(--winui-control-strong-stroke-disabled);
  }

  /* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L145
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L149 */
  .fui-Radio .fui-Radio__input:disabled:checked ~ .fui-Radio__indicator.fui-Radio__indicator {
    background-color: var(--winui-accent-fill-disabled);
    border-color: var(--winui-accent-fill-disabled);
  }

  /* The desaturated ellipse is no longer an accent surface, so the dot's ring
     leaves the on-accent strokes for the neutral ones.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L161 */
  .fui-Radio
    .fui-Radio__input:disabled:checked
    ~ .fui-Radio__indicator.fui-Radio__indicator::after {
    border-color: var(--winui-control-elevation-border-color);
  }

  /* The radio's focus visual is the check box's, so the two rings are built
     the same way.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L196 */
  .fui-Radio.fui-Radio[data-fui-focus-within]:focus-within::after {
    border-color: var(--winui-focus-stroke-outer);
    box-shadow: inset 0 0 0 1px var(--winui-focus-stroke-inner);
  }
}
`;
