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
// The knob is also the one subject in the layer that the doubling convention
// cannot be applied to. Fluent renders it as the indicator's only child and
// gives it no class of its own, addressing it as `> *` from the indicator's
// reset class; every knob rule here therefore doubles the indicator instead,
// which puts the pair one class above that reset atom exactly as a doubled
// subject would.
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-switch/library/src/components/Switch/useSwitchStyles.styles.ts#L74-L82
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
.fui-Switch__indicator.fui-Switch__indicator {
  align-items: center;
  display: flex;
}

/* The knob is drawn once. Fluent renders it as an SVG glyph, and this file
   paints the element's own background instead so the shape can be a capsule
   rather than a circle -- the pressed state stretches it to 17x14, which no
   glyph does. The glyph itself has to go, or it shows through as a second,
   circular knob inside the first: \`fill\` on the SVG does not reach the path
   that draws it, so the path is named. */
.fui-Switch__indicator.fui-Switch__indicator > * > * {
  fill: transparent;
}

.fui-Switch__indicator.fui-Switch__indicator > * {
  background: currentColor;
  border-radius: 999px;
  height: 12px;
  margin-inline-start: 2.5px;
  /* One timing for every property the knob moves. Fluent slides the knob with a
     transform and this file resizes it, and while the two ran on different
     durations the knob finished growing before it finished travelling -- the
     square background of the glyph element showing past the round one it is
     meant to sit under, which reads as a second ring while the pointer is
     down. */
  transition-duration: var(--winui-control-faster-animation-duration);
  transition-property: transform, width, height, margin-inline-start;
  transition-timing-function: var(--winui-control-fast-out-slow-in-easing);
  width: 12px;
}

@media screen and (prefers-reduced-motion: reduce) {
  .fui-Switch__indicator.fui-Switch__indicator > * {
    transition-duration: 0.01ms;
  }
}

/* Off: WinUI puts the whole pointer response on the track fill and holds both
   the stroke (ToggleSwitchStrokeOff) and the knob (TextFillColorSecondary) at
   their rest values, so Fluent's stroke-accessible and knob shifts are pinned
   back and the alt-fill ramp carries hover and press instead.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleSwitch_themeresources.xaml#L135-L141
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleSwitch_themeresources.xaml#L151-L153 */
.fui-Switch__input:enabled:not(:checked):not([aria-disabled='true']) ~ .fui-Switch__indicator.fui-Switch__indicator,
.fui-Switch__input:enabled:not(:checked):not([aria-disabled='true']):hover ~ .fui-Switch__indicator.fui-Switch__indicator,
.fui-Switch__input:enabled:not(:checked):not([aria-disabled='true']):hover:active ~ .fui-Switch__indicator.fui-Switch__indicator {
  border-color: var(--winui-control-strong-stroke-default);
  color: var(--winui-text-fill-secondary);
}

.fui-Switch__input:enabled:not(:checked):not([aria-disabled='true']) ~ .fui-Switch__indicator.fui-Switch__indicator {
  background-color: var(--winui-control-alt-fill-secondary);
}

.fui-Switch__input:enabled:not(:checked):not([aria-disabled='true']):hover ~ .fui-Switch__indicator.fui-Switch__indicator {
  background-color: var(--winui-control-alt-fill-tertiary);
}

.fui-Switch__input:enabled:not(:checked):not([aria-disabled='true']):hover:active ~ .fui-Switch__indicator.fui-Switch__indicator {
  background-color: var(--winui-control-alt-fill-quarternary);
}

/* The knob is 12x12 at rest, swells to 14x14 under the pointer and stretches to
   17x14 while pressed -- a capsule, not a circle, which is why the shape is the
   element's own background rather than a glyph. The template animates Width and
   Height themselves rather than a scale, over ControlFasterAnimationDuration on
   the fast-out-slow-in spline, and the margins keep the growth centred on the
   track's leading edge until the press pushes it 3px along.

   The state is taken from the root rather than from the input. Fluent's input
   is visually hidden and a pixel wide, so it never sees the pointer -- the
   track does -- and keyed off the input these rules never fired at all.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleSwitch_themeresources.xaml#L274-L287 */
.fui-Switch:hover .fui-Switch__input:enabled:not([aria-disabled='true']) ~ .fui-Switch__indicator.fui-Switch__indicator > * {
  height: 14px;
  margin-inline-start: 1.5px;
  width: 14px;
}

.fui-Switch:active .fui-Switch__input:enabled:not([aria-disabled='true']) ~ .fui-Switch__indicator.fui-Switch__indicator > * {
  margin-inline-start: 2px;
  width: 17px;
}

.fui-Switch:active .fui-Switch__input:enabled:checked:not([aria-disabled='true']) ~ .fui-Switch__indicator.fui-Switch__indicator > * {
  margin-inline-start: -1px;
}

/* On: the accent fill ramp. WinUI draws the on-state stroke at thickness 0, and
   Fluent's own checked border is already transparent over a border-box
   background, so the fill alone reproduces the edgeless track — painting the
   border with the same ramp would composite these translucent accents twice.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleSwitch_themeresources.xaml#L143-L150 */
.fui-Switch__input:enabled:checked:not([aria-disabled='true']) ~ .fui-Switch__indicator.fui-Switch__indicator {
  background-color: var(--winui-accent-fill-default);
  color: var(--winui-text-on-accent-fill-primary);
}

.fui-Switch__input:enabled:checked:not([aria-disabled='true']):hover ~ .fui-Switch__indicator.fui-Switch__indicator {
  background-color: var(--winui-accent-fill-secondary);
}

.fui-Switch__input:enabled:checked:not([aria-disabled='true']):hover:active ~ .fui-Switch__indicator.fui-Switch__indicator {
  background-color: var(--winui-accent-fill-tertiary);
}

/* The on knob is the one part of this control that carries an elevation stroke:
   ToggleSwitchKnobStrokeOn is CircleElevationBorderBrush, light along the top
   and sides over a heavier bottom edge. WinUI keeps it across every on state,
   including disabled. Since the knob paints its own box, the stroke is drawn as
   inset shadows, which leaves the sizes stated above measuring the knob itself.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleSwitch_themeresources.xaml#L159 */
.fui-Switch__input:checked ~ .fui-Switch__indicator.fui-Switch__indicator > * {
  box-shadow: var(--winui-circle-elevation-shadow);
}

/* Disabled on: the accent ramp keeps carrying the track, and the knob moves to
   the disabled on-accent text fill. Disabled off still needs no rule — the
   alt-fill ramp above is scoped to the enabled track and ToggleSwitchFillOffDisabled
   is fully transparent in both dictionaries, which is what Fluent already
   leaves there; its disabled stroke and foreground are the WinUI values, and
   WinUI returns the knob to its rest size.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleSwitch_themeresources.xaml#L138
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleSwitch_themeresources.xaml#L146-L158 */
.fui-Switch__input:disabled:checked ~ .fui-Switch__indicator.fui-Switch__indicator,
.fui-Switch__input[aria-disabled='true']:checked ~ .fui-Switch__indicator.fui-Switch__indicator {
  background-color: var(--winui-accent-fill-disabled);
  color: var(--winui-text-on-accent-fill-disabled);
}

/* Focus: Fluent already draws a 2px ring around the whole control, so only its
   colour is restated as FocusStrokeColorOuter. WinUI backs that primary stroke
   with a thinner FocusStrokeColorInner one and inflates the pair by
   FocusVisualMargin -7,-3,-7,-3 around SwitchAreaGrid; neither the two
   thicknesses nor that template part is expressed in the theme dictionaries, so
   the inner stroke and the inflation stay as Fluent draws them.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleSwitch_themeresources.xaml#L200
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L258-L259 */
.fui-Switch.fui-Switch[data-fui-focus-within]:focus-within::after {
  border-color: var(--winui-focus-stroke-outer);
}
`;
