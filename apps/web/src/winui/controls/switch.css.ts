// Switch restyled as WinUI 3's ToggleSwitch. Fluent's medium track already
// matches WinUI's OuterBorder — 40x20, fully round, 1px stroke, knob travel of
// 20px — so the track box carries over untouched and only the knob's shape and
// the paint of both parts are restated here.
//
// WinUI's knob is a 12x12 rectangle centered in a left-aligned 20x20 cell,
// while Fluent's is a circle glyph filling the track height. We keep Fluent's
// element and its translate, blank the glyph, and paint the knob as the
// element's own box.
//
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleSwitch_themeresources.xaml#L507-L521
//
// Knob sizes and gaps are expressed as a share of the indicator's content box
// — 38x18 at Fluent's medium size — so Fluent's small track, which WinUI has no
// counterpart for, scales the same proportions instead of overflowing. Every
// offset below is stated relative to the track's outer edge and then reduced
// by the 1px border the content box is inset by.
//
// XAML centres each knob inside the 20x20 cell minus its own margin, so the
// 12x12 off knob (Margin="-1,0,0,0") sits at -1 + (21 - 12) / 2 = 3.5px and the
// on knob (Margin="0,0,1,0") at (19 - 12) / 2 = 3.5px within a cell that
// translates by 20px — a leading gap of 3.5px against a trailing 4.5px. One
// translated element reproduces both, since the two knobs share that offset.
export const switchCss = `
/* The knob is centered in the track by laying the indicator out as a flex row;
   its own box paints the knob, so the glyph is blanked and the background
   picks up whatever colour Fluent's state cascade has already resolved. The
   knob is fully round at every size — WinUI gives it CornerRadius 7 against a
   height that never exceeds 14.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleSwitch_themeresources.xaml#L509-L515

   Size and gap animate over ControlFasterAnimationDuration on the
   ControlFastOutSlowInKeySpline; the travel keeps Fluent's timing, since WinUI
   moves KnobTranslateTransform with Duration="0" and states no curve for it.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L602-L606 */
.fui-FluentProvider .fui-Switch__indicator {
  align-items: center;
  display: flex;
}

.fui-FluentProvider .fui-Switch__indicator > * {
  background: currentColor;
  border-radius: 999px;
  fill: transparent;
  height: 66.667%;
  margin-inline-start: 6.579%;
  transition:
    transform var(--durationNormal) var(--curveEasyEase),
    width 83ms cubic-bezier(0, 0, 0, 1),
    height 83ms cubic-bezier(0, 0, 0, 1),
    margin-inline-start 83ms cubic-bezier(0, 0, 0, 1);
  width: 31.579%;
}

@media screen and (prefers-reduced-motion: reduce) {
  .fui-FluentProvider .fui-Switch__indicator > * {
    transition-duration: 0.01ms;
  }
}

/* Off knob: TextFillColorSecondary, and WinUI holds it there through hover and
   press instead of following the track stroke the way Fluent does.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleSwitch_themeresources.xaml#L151-L153

   WinUI carries off-state hover and press on the track fill alone
   (ControlAltFillColorTertiary / Quarternary) and holds the stroke at
   ToggleSwitchStrokeOff. Those two fills have no token here, so pinning the
   stroke as well would leave the off track with no pointer feedback at all;
   Fluent's stroke-accessible shift is left in place to carry it.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleSwitch_themeresources.xaml#L136-L141 */
.fui-FluentProvider .fui-Switch__input:enabled:not(:checked):not([aria-disabled="true"]) ~ .fui-Switch__indicator,
.fui-FluentProvider .fui-Switch__input:enabled:not(:checked):not([aria-disabled="true"]):hover ~ .fui-Switch__indicator,
.fui-FluentProvider .fui-Switch__input:enabled:not(:checked):not([aria-disabled="true"]):hover:active ~ .fui-Switch__indicator {
  color: var(--winui-text-fill-secondary);
}

/* The knob swells to 14x14 under the pointer, keeping its margins, so the same
   centring puts it 2.5px from the leading edge. Press then realigns it against
   that edge at 3px and stretches it to 17px wide, and the checked press pins
   the opposite end 3px from the trailing edge instead.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleSwitch_themeresources.xaml#L274-L287 */
.fui-FluentProvider .fui-Switch__input:enabled:not([aria-disabled="true"]):hover ~ .fui-Switch__indicator > * {
  height: 77.778%;
  margin-inline-start: 3.947%;
  width: 36.842%;
}

.fui-FluentProvider .fui-Switch__input:enabled:not([aria-disabled="true"]):hover:active ~ .fui-Switch__indicator > * {
  margin-inline-start: 5.263%;
  width: 44.737%;
}

.fui-FluentProvider .fui-Switch__input:enabled:checked:not([aria-disabled="true"]):hover:active ~ .fui-Switch__indicator > * {
  margin-inline-start: -2.632%;
}

/* On: the accent fill ramp. WinUI draws the on-state stroke at thickness 0, and
   Fluent's own checked border is already transparent over a border-box
   background, so the fill alone reproduces the edgeless track — painting the
   border with the same ramp would composite these translucent accents twice.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleSwitch_themeresources.xaml#L143-L150 */
.fui-FluentProvider .fui-Switch__input:enabled:checked:not([aria-disabled="true"]) ~ .fui-Switch__indicator {
  background-color: var(--winui-accent-fill-default);
  color: var(--winui-text-on-accent-fill-primary);
}

.fui-FluentProvider .fui-Switch__input:enabled:checked:not([aria-disabled="true"]):hover ~ .fui-Switch__indicator {
  background-color: var(--winui-accent-fill-secondary);
}

.fui-FluentProvider .fui-Switch__input:enabled:checked:not([aria-disabled="true"]):hover:active ~ .fui-Switch__indicator {
  background-color: var(--winui-accent-fill-tertiary);
}

/* Disabled on: the accent ramp keeps carrying the track, and the knob moves to
   the disabled on-accent text fill. Disabled off needs no rule — Fluent's
   disabled stroke and foreground are already the WinUI values, and WinUI
   returns the knob to its rest size there.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleSwitch_themeresources.xaml#L146-L158 */
.fui-FluentProvider .fui-Switch__input:disabled:checked ~ .fui-Switch__indicator,
.fui-FluentProvider .fui-Switch__input[aria-disabled="true"]:checked ~ .fui-Switch__indicator {
  background-color: var(--winui-accent-fill-disabled);
  color: var(--winui-text-on-accent-fill-disabled);
}
`;
