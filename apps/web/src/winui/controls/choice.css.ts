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
// Fluent. Geometry applies in both modes, except the focus ring's stand-off,
// which rides with the ring's colours so that forced colours keeps Fluent's
// ring whole rather than half of ours.
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

  /* Unchecked box. The outline holds ControlStrongStrokeColorDefault across
     rest and pointer-over, so one rule replaces Fluent's rest and hover pair,
     but the interior is a cavity that washes one step further down the alt-fill
     ramp per state, which Fluent leaves transparent throughout.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L217-L218
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L229 */
  .fui-FluentProvider
    .fui-Checkbox__input:enabled:not(:checked):not(:indeterminate)
    ~ .fui-Checkbox__indicator {
    background-color: var(--winui-control-alt-fill-secondary);
    border-color: var(--winui-control-strong-stroke-default);
  }

  /* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L230 */
  .fui-FluentProvider
    .fui-Checkbox:hover
    .fui-Checkbox__input:enabled:not(:checked):not(:indeterminate)
    ~ .fui-Checkbox__indicator {
    background-color: var(--winui-control-alt-fill-tertiary);
  }

  /* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L219
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L231 */
  .fui-FluentProvider
    .fui-Checkbox:active
    .fui-Checkbox__input:enabled:not(:checked):not(:indeterminate)
    ~ .fui-Checkbox__indicator {
    background-color: var(--winui-control-alt-fill-quarternary);
    border-color: var(--winui-control-strong-stroke-disabled);
  }

  /* The disabled cavity is the one alt-fill step that is fully transparent, so
     it is the unchecked box, not the checked one, that loses its interior.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L232 */
  .fui-FluentProvider
    .fui-Checkbox__input:disabled:not(:checked):not(:indeterminate)
    ~ .fui-Checkbox__indicator {
    background-color: var(--winui-control-alt-fill-disabled);
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

  /* Focus ring. WinUI's focus visual is two concentric rings — an outer one in
     the text colour and an inner one in the surface colour — so it stays legible
     over any fill, where Fluent draws a single accent-adjacent stroke. The
     inner ring is an inset shadow because it must sit inside the outer ring's
     own border box. CheckBoxFocusVisualMargin is negative, so the ring stands
     off the root by 7px horizontally and 3px vertically instead of Fluent's
     uniform 2px. The radius stays Fluent's, which already resolves to
     ControlCornerRadius.
     The two ring thicknesses are the framework defaults, which this corpus
     states only where ListViewItem restates them.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L275
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L258-L259
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L250-L252 */
  .fui-FluentProvider .fui-Checkbox[data-fui-focus-within]:focus-within::after {
    top: -3px;
    right: -7px;
    bottom: -3px;
    left: -7px;
    border-color: var(--winui-focus-stroke-outer);
    box-shadow: inset 0 0 0 1px var(--winui-focus-stroke-inner);
  }
}

/* Radio geometry. The outer ellipse is 20px and the checked dot is sized in
   absolute pixels per state — 12 at rest, 14 on pointer-over, 10 while
   pressed — so the dot's scale factor is that size over the 20px ellipse,
   replacing Fluent's single 0.625 of a 16px box. WinUI grows and shrinks the
   dot over ControlNormalAnimationDuration on the fast-out-slow-in spline, which
   the transform transition restates. The return to rest runs instead at
   ControlFastAnimationDuration, which the token vocabulary does not carry, so
   both directions here take the normal duration.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L371
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L179-L181
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L256
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L293 */
.fui-FluentProvider .fui-Radio__indicator {
  width: 20px;
  height: 20px;
}

.fui-FluentProvider .fui-Radio__indicator::after {
  width: 20px;
  height: 20px;
  transform: scale(0.6);
  transition:
    transform var(--winui-control-normal-animation-duration)
      var(--winui-control-fast-out-slow-in-easing);
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

  /* Unselected ellipse. The outline holds ControlStrongStrokeColorDefault
     across rest and pointer-over, then drops to the disabled strong stroke
     while pressed, while the interior washes one step further down the
     alt-fill ramp per state where Fluent leaves it transparent.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L134-L135
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L138 */
  .fui-FluentProvider .fui-Radio .fui-Radio__input:enabled:not(:checked) ~ .fui-Radio__indicator {
    background-color: var(--winui-control-alt-fill-secondary);
    border-color: var(--winui-control-strong-stroke-default);
  }

  /* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L139 */
  .fui-FluentProvider
    .fui-Radio
    .fui-Radio__input:enabled:not(:checked):hover
    ~ .fui-Radio__indicator {
    background-color: var(--winui-control-alt-fill-tertiary);
  }

  /* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L136
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L140 */
  .fui-FluentProvider
    .fui-Radio
    .fui-Radio__input:enabled:not(:checked):active
    ~ .fui-Radio__indicator {
    background-color: var(--winui-control-alt-fill-quarternary);
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

  /* The dot carries a hairline elevation stroke over its accent surround, drawn
     as a real border rather than the inset shadow the wider elevation strokes
     use: at 12px an inset ring closes into a filled disc. Border-box sizing
     keeps the ring inside the geometry the scale factor above establishes.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L150
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L153
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L158-L160 */
  .fui-FluentProvider .fui-Radio .fui-Radio__indicator::after {
    box-sizing: border-box;
    background-color: var(--winui-text-on-accent-fill-primary);
    border: 1px solid;
    border-color: var(--winui-accent-control-elevation-border-color);
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
     accent-shaped and desaturates it rather than flattening it to a neutral,
     and empties the unselected cavity outright.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L137
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L141 */
  .fui-FluentProvider .fui-Radio .fui-Radio__input:disabled:not(:checked) ~ .fui-Radio__indicator {
    background-color: var(--winui-control-alt-fill-disabled);
    border-color: var(--winui-control-strong-stroke-disabled);
  }

  /* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L145
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L149 */
  .fui-FluentProvider .fui-Radio .fui-Radio__input:disabled:checked ~ .fui-Radio__indicator {
    background-color: var(--winui-accent-fill-disabled);
    border-color: var(--winui-accent-fill-disabled);
  }

  /* The desaturated ellipse is no longer an accent surface, so the dot's ring
     leaves the on-accent strokes for the neutral ones.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L161 */
  .fui-FluentProvider
    .fui-Radio
    .fui-Radio__input:disabled:checked
    ~ .fui-Radio__indicator::after {
    border-color: var(--winui-control-elevation-border-color);
  }

  /* The radio's focus visual is the check box's, down to the same negative
     margin, so the two rings are built the same way.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L196 */
  .fui-FluentProvider .fui-Radio[data-fui-focus-within]:focus-within::after {
    top: -3px;
    right: -7px;
    bottom: -3px;
    left: -7px;
    border-color: var(--winui-focus-stroke-outer);
    box-shadow: inset 0 0 0 1px var(--winui-focus-stroke-inner);
  }
}
`;
