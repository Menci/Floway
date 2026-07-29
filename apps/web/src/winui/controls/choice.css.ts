// Checkbox and Radio, restyled from the Fluent 2 Web look to WinUI 3.
//
// Two shape changes drive most of what follows. WinUI's check box and radio
// ellipse are both 20px rather than Fluent's 16px, and WinUI paints the
// selected state as a filled accent shape carrying a light glyph, where Fluent
// leaves the box hollow and tints the glyph itself. Border and glyph therefore
// swap roles on selection, so the checked and indeterminate rules restate
// background, border, and glyph colour together rather than adjusting one.
//
// Fluent drives its indicator colours through `--fui-Checkbox__indicator--*`
// custom properties declared on the root. We paint the indicator element
// directly instead: the state selectors below read the input's own `:checked`,
// `:indeterminate`, `:enabled`, and `:disabled`, which keeps a single rule
// covering the Fluent states that share one WinUI value.
//
// Radio keeps its whole state machine in one Griffel reset whose selectors run
// from `.rg1upok:enabled:checked ~ .fui-Radio__indicator` at (0,5,0) up to
// (0,7,0) for the pressed steps. Every radio rule below therefore carries the
// provider scope, the root class, and the input's pseudo-classes solely to
// outrank that reset; the check box needs only the provider scope, because
// Fluent varies it through single-class atoms on the root.
//
// Colour is confined to `@media not (forced-colors: active)`. Fluent already
// paints both controls with the system Highlight and GrayText keywords under
// Windows High Contrast, and WinUI's own answer there is a HighContrast theme
// dictionary we do not transcribe, so the forced-colours pass is left to
// Fluent. Geometry applies in both modes.
export const choiceCss = `
/* Check box geometry. WinUI draws one box at CheckBoxSize with a
   CheckBoxGlyphSize glyph inside it and has no second size, so both Fluent
   sizes are pulled onto those two numbers — the medium box grows from 16px and
   the large glyph shrinks from 16px. The box's corner radius is already
   ControlCornerRadius through the themed \`borderRadiusSmall\` Fluent's
   indicator reset reads, so restating it here would only cost \`shape="circular"\`
   its circle.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L270-L271
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L603 */
.fui-FluentProvider .fui-Checkbox__indicator {
  width: 20px;
  height: 20px;
  font-size: 12px;
}

/* The input is the hit target and the label's optical centring is a function
   of the box, so both follow it off Fluent's 16px geometry. */
.fui-FluentProvider .fui-Checkbox__input {
  width: calc(20px + 2 * var(--spacingHorizontalS));
}

.fui-FluentProvider .fui-Checkbox__label {
  margin-top: calc((20px - var(--lineHeightBase300)) / 2);
  margin-bottom: calc((20px - var(--lineHeightBase300)) / 2);
}

@media not (forced-colors: active) {
  /* WinUI holds the label at TextFillColorPrimary through every enabled state,
     where Fluent walks a three-step neutral ramp from rest to pressed.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L181-L183 */
  .fui-FluentProvider .fui-Checkbox,
  .fui-FluentProvider .fui-Checkbox:hover,
  .fui-FluentProvider .fui-Checkbox:active {
    color: var(--winui-text-fill-primary);
  }

  /* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L184 */
  .fui-FluentProvider .fui-Checkbox__input:disabled ~ .fui-Checkbox__label {
    color: var(--winui-text-fill-disabled);
  }

  /* Unchecked box outline. WinUI keeps ControlStrongStrokeColorDefault on both
     rest and pointer-over, so one rule replaces Fluent's rest and hover pair.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L217-L218 */
  .fui-FluentProvider
    .fui-Checkbox__input:enabled:not(:checked):not(:indeterminate)
    ~ .fui-Checkbox__indicator {
    border-color: var(--winui-control-strong-stroke-default);
  }

  /* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L219 */
  .fui-FluentProvider
    .fui-Checkbox:active
    .fui-Checkbox__input:enabled:not(:checked):not(:indeterminate)
    ~ .fui-Checkbox__indicator {
    border-color: var(--winui-control-strong-stroke-disabled);
  }

  /* Selected box. WinUI gives Indeterminate the same accent fill and stroke as
     Checked and differs only in the glyph it draws, so both states share these
     rules; Fluent instead leaves the indeterminate box hollow.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L221
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L225
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L233
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L237
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L245
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L249 */
  .fui-FluentProvider .fui-Checkbox__input:enabled:checked ~ .fui-Checkbox__indicator,
  .fui-FluentProvider .fui-Checkbox__input:enabled:indeterminate ~ .fui-Checkbox__indicator {
    background-color: var(--winui-accent-fill-default);
    border-color: var(--winui-accent-fill-default);
    color: var(--winui-text-on-accent-fill-primary);
  }

  /* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L222
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L234 */
  .fui-FluentProvider
    .fui-Checkbox:hover
    .fui-Checkbox__input:enabled:checked
    ~ .fui-Checkbox__indicator,
  .fui-FluentProvider
    .fui-Checkbox:hover
    .fui-Checkbox__input:enabled:indeterminate
    ~ .fui-Checkbox__indicator {
    background-color: var(--winui-accent-fill-secondary);
    border-color: var(--winui-accent-fill-secondary);
  }

  /* Pressed also dims the glyph, which is the one place WinUI reaches for
     TextOnAccentFillColorSecondary.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L223
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L235
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L247 */
  .fui-FluentProvider
    .fui-Checkbox:active
    .fui-Checkbox__input:enabled:checked
    ~ .fui-Checkbox__indicator,
  .fui-FluentProvider
    .fui-Checkbox:active
    .fui-Checkbox__input:enabled:indeterminate
    ~ .fui-Checkbox__indicator {
    background-color: var(--winui-accent-fill-tertiary);
    border-color: var(--winui-accent-fill-tertiary);
    color: var(--winui-text-on-accent-fill-secondary);
  }

  /* Disabled. WinUI keeps the selected box accent-shaped and only desaturates
     it, and keeps the glyph on the on-accent ramp, where Fluent collapses every
     disabled check box onto one neutral appearance.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L220
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L248 */
  .fui-FluentProvider .fui-Checkbox__input:disabled ~ .fui-Checkbox__indicator {
    border-color: var(--winui-control-strong-stroke-disabled);
    color: var(--winui-text-on-accent-fill-disabled);
  }

  /* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L236
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L240 */
  .fui-FluentProvider .fui-Checkbox__input:disabled:checked ~ .fui-Checkbox__indicator,
  .fui-FluentProvider .fui-Checkbox__input:disabled:indeterminate ~ .fui-Checkbox__indicator {
    background-color: var(--winui-accent-fill-disabled);
  }
}

/* Radio geometry. The outer ellipse is 20px and the checked dot is sized in
   absolute pixels per state — 12 at rest, 14 on pointer-over, 10 while
   pressed — so the dot's scale factor is that size over the 20px ellipse,
   replacing Fluent's single 0.625 of a 16px box.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L371
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L179-L181 */
.fui-FluentProvider .fui-Radio__indicator {
  width: 20px;
  height: 20px;
}

.fui-FluentProvider .fui-Radio__indicator::after {
  width: 20px;
  height: 20px;
  transform: scale(0.6);
}

/* The input is the hit target and has to span the grown ellipse and its
   margins. It is widened through min-width because labelPosition="below"
   stacks the label under the ellipse and stretches the input to the full root
   width; a floor leaves that stretch intact. */
.fui-FluentProvider .fui-Radio__input {
  min-width: calc(20px + 2 * var(--spacingHorizontalS));
}

/* Fluent pulls the label 2px into the row so a 20px line box does not outgrow
   its 16px ellipse. At a 20px ellipse the two agree, so this resolves to zero
   and the "below" layout, which Fluent gives no margin at all, is unaffected. */
.fui-FluentProvider .fui-Radio__label {
  margin-top: calc((20px - var(--lineHeightBase300)) / 2);
  margin-bottom: calc((20px - var(--lineHeightBase300)) / 2);
}

/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L180 */
.fui-FluentProvider
  .fui-Radio
  .fui-Radio__input:enabled:checked:hover
  ~ .fui-Radio__indicator::after {
  transform: scale(0.7);
}

/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L181 */
.fui-FluentProvider
  .fui-Radio
  .fui-Radio__input:enabled:checked:hover:active
  ~ .fui-Radio__indicator::after {
  transform: scale(0.5);
}

@media not (forced-colors: active) {
  /* WinUI holds the radio label at TextFillColorPrimary through every enabled
     state, where Fluent walks a neutral ramp for the unselected control.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L122-L124 */
  .fui-FluentProvider .fui-Radio .fui-Radio__input:enabled ~ .fui-Radio__label,
  .fui-FluentProvider .fui-Radio .fui-Radio__input:enabled:hover ~ .fui-Radio__label,
  .fui-FluentProvider .fui-Radio .fui-Radio__input:enabled:hover:active ~ .fui-Radio__label {
    color: var(--winui-text-fill-primary);
  }

  /* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L125 */
  .fui-FluentProvider .fui-Radio .fui-Radio__input:disabled ~ .fui-Radio__label {
    color: var(--winui-text-fill-disabled);
  }

  /* Unselected ellipse outline. WinUI holds ControlStrongStrokeColorDefault
     across rest and pointer-over, then drops to the disabled strong stroke
     while pressed.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L134-L135 */
  .fui-FluentProvider .fui-Radio .fui-Radio__input:enabled:not(:checked) ~ .fui-Radio__indicator {
    border-color: var(--winui-control-strong-stroke-default);
  }

  /* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L136 */
  .fui-FluentProvider
    .fui-Radio
    .fui-Radio__input:enabled:not(:checked):active
    ~ .fui-Radio__indicator {
    border-color: var(--winui-control-strong-stroke-disabled);
  }

  /* Selected ellipse. WinUI fills the whole 20px ellipse with accent and lays
     the dot on top in the on-accent foreground; Fluent leaves the ellipse
     hollow and paints the dot in the accent colour, so the two swap roles. The
     dot's fill is the same in every state, disabled included, so it is declared
     once.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L142
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L146 */
  .fui-FluentProvider .fui-Radio .fui-Radio__input:enabled:checked ~ .fui-Radio__indicator {
    background-color: var(--winui-accent-fill-default);
    border-color: var(--winui-accent-fill-default);
  }

  /* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L150
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L153 */
  .fui-FluentProvider .fui-Radio .fui-Radio__indicator::after {
    background-color: var(--winui-text-on-accent-fill-primary);
  }

  /* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L143
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L147 */
  .fui-FluentProvider
    .fui-Radio
    .fui-Radio__input:enabled:checked:hover
    ~ .fui-Radio__indicator {
    background-color: var(--winui-accent-fill-secondary);
    border-color: var(--winui-accent-fill-secondary);
  }

  /* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L144
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L148 */
  .fui-FluentProvider
    .fui-Radio
    .fui-Radio__input:enabled:checked:hover:active
    ~ .fui-Radio__indicator {
    background-color: var(--winui-accent-fill-tertiary);
    border-color: var(--winui-accent-fill-tertiary);
  }

  /* Disabled. As with the check box, WinUI keeps the selected ellipse
     accent-shaped and desaturates it rather than flattening it to a neutral.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L137 */
  .fui-FluentProvider .fui-Radio .fui-Radio__input:disabled:not(:checked) ~ .fui-Radio__indicator {
    border-color: var(--winui-control-strong-stroke-disabled);
  }

  /* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L145
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L149 */
  .fui-FluentProvider .fui-Radio .fui-Radio__input:disabled:checked ~ .fui-Radio__indicator {
    background-color: var(--winui-accent-fill-disabled);
    border-color: var(--winui-accent-fill-disabled);
  }
}
`;
