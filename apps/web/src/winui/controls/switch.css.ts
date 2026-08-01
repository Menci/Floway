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
// The track is two stacked capsules, not one. XAML draws OuterBorder — the off
// fill and its stroke — under SwitchKnobBounds, which carries the accent fill at
// Opacity="0", and toggling cross-fades their opacities. That is why the track
// washes out towards the page behind it half way through: for a moment neither
// capsule is fully opaque. A single element interpolating one background-color
// travels straight between the two fills and cannot show it, so the two
// capsules are reproduced as the indicator's two pseudo-elements. Fluent draws
// on neither of them — its focus ring is ::after on the root — and the
// indicator's own fill and stroke are handed over to them.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleSwitch_themeresources.xaml#L507-L508
//
// Knob sizes and gaps are written as multiples of a unit the size sets, so
// Fluent's small track — which WinUI has no counterpart for — carries the same
// proportions instead of the medium size's pixels. The unit is the ratio of the
// two content boxes, 14 over 18, which is what keeps the knob's travel landing
// inside the track: at medium's literal 12px the small knob finished half a
// pixel past the track's inner edge. Every offset below is stated relative to
// the track's outer edge and then reduced by the 1px border the content box is
// inset by.
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
// translates by 20px — a leading gap of 3.5px against a trailing 4.5px. The two
// knobs share that offset, so one translated element carries both positions.
//
// Their cross-fade it does not carry. XAML stacks SwitchKnobOff under
// SwitchKnobOn and toggles the pair's opacities exactly as it does the two
// track capsules, so the accent capsule shows through the knob half way; the
// one element interpolates its fill from the off colour to the on colour and
// stays opaque throughout. The two-capsule construction is not available here:
// Fluent's knob is an SVG element, and an SVG element generates no ::before or
// ::after box to stack a second knob in.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleSwitch_themeresources.xaml#L510-L520
export const switchCss = `
/* The whole control is the drag surface, not the knob: XAML lays a transparent
   Thumb across all three rows and columns, so the caption drags the switch too.
   ManipulationMode="System,TranslateX" claims the horizontal axis for the
   control and leaves the vertical one to the scroller above it, which is what
   touch-action: pan-y says here.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleSwitch_themeresources.xaml#L197
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleSwitch_themeresources.xaml#L524-L528 */
.fui-Switch.fui-Switch {
  touch-action: pan-y;
}

/* The knob is centered in the track by laying the indicator out as a flex row.
   The indicator itself paints nothing and animates nothing: the fill and stroke
   belong to the two capsules below it and the knob paints its own.

   Size and gap animate over ControlFasterAnimationDuration on the
   ControlFastOutSlowInKeySpline; the travel is a RepositionThemeAnimation, on
   the timing ../motion.ts transcribes from the OS.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L602-L606 */
.fui-Switch__indicator.fui-Switch__indicator {
  align-items: center;
  align-self: center;
  background-color: transparent;
  border-color: transparent;
  display: flex;
  /* Fluent rings the track with eight pixels of margin, which builds a hit
     target and spaces the label in one stroke. Inline, the twelve the
     template's gap column states takes over, declared on the root because that
     is the only form which survives the label moving to either side.

     Block-wise WinUI states ten above and ten below the 20px track, making the
     switch body 40px tall. The dashboard drops that and runs the switch at the
     one control-row height its forms share; that is the operator's decision
     about this app's form rows, not a reading of the template.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleSwitch_themeresources.xaml#L186-L187
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleSwitch_themeresources.xaml#L495-L501 */
  margin: 0;
  position: relative;
  transition-property: none;
}

.fui-Switch.fui-Switch {
  align-items: center;
  gap: 12px;
}

/* Fluent pads the label eight pixels block-wise and eight inline, trimmed to
   four on the side facing the track. Inline that is superseded by the 12px gap
   the root declares; block-wise it is the last thing holding the root taller
   than the track, and it goes with the indicator's block margin, on the same
   choice of the operator's stated at the rule above. */
.fui-Switch__label.fui-Switch__label {
  padding: 0;
}

/* A switch that carries a label is a field standing beside inputs and combo
   boxes, so it takes the row height those share; one that does not is a control
   in a cell, and is only itself. Both the 34 and the gate are the operator's
   choice for this app's forms -- WinUI states 40 for every switch, labelled or
   not. ./text-input.css.ts is where the 34 is written down. */
.fui-Switch.fui-Switch:has(> .fui-Switch__label) {
  min-height: 34px;
}

/* Turning on cross-fades the two capsules over ControlFasterAnimationDuration,
   linearly: OffToOnTransition states a LinearDoubleKeyFrame on each of the four
   opacities it touches.

   Turning off does not fade at all. OnToOffTransition carries GeneratedDuration
   0 and a storyboard holding nothing but the RepositionThemeAnimation, and the
   Off state is empty, so leaving On stops the On storyboard and every opacity it
   was holding reverts to the element's own value in one tick. The knob is still
   sliding while the colour has already arrived.

   Measuring the shipped control against a 60fps capture agrees on both halves:
   turning on takes 84 +/- 3ms across five toggles with five or six intermediate
   frames each, and turning off completes inside a single frame, with the
   pointer-state ramp that starts alongside it not yet advanced one quantisation
   step. So one duration is declared here and it is the on direction's; the off
   direction is what remains when nothing animates.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleSwitch_themeresources.xaml#L418-L439
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleSwitch_themeresources.xaml#L442 */
.fui-Switch__indicator.fui-Switch__indicator {
  --winui-switch-crossfade-duration: 0s;
  --winui-switch-travel-duration: var(--winui-reposition-animation-duration);
  --winui-switch-unit: 1px;
}

/* 14 over 18: the small track's content box against the medium one's. */
.fui-Switch[data-winui-size='small'] .fui-Switch__indicator.fui-Switch__indicator {
  --winui-switch-unit: 0.7778px;
}

.fui-Switch__input:checked ~ .fui-Switch__indicator.fui-Switch__indicator {
  --winui-switch-crossfade-duration: var(--winui-control-faster-animation-duration);
}

/* Dragging. The knob is glued to the pointer -- XAML writes KnobTranslateTransform.X
   on every DragDelta with no storyboard behind it -- so the travel transition is
   switched off for the length of the gesture and the position comes in as a
   custom property the drag writes.

   Nothing about the fill moves either. Entering the empty Dragging state would
   let the On storyboard's opacities revert, and OnToDraggingTransition re-asserts
   them at KeyTime 0 to stop exactly that; the control holds the appearance of
   the state it started from until the pointer is released. Here that falls out
   for free, because the checkbox does not flip until the gesture commits.

   Settling out of a drag does fade, in both directions. That is the one place
   the off direction is not instant: DraggingToOffTransition carries the same
   four 83ms opacity keyframes DraggingToOnTransition does, where OnToOffTransition
   -- the click path -- carries none.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleSwitch_themeresources.xaml#L391-L403
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleSwitch_themeresources.xaml#L404-L417 */
.fui-Switch[data-winui-switch-dragging] .fui-Switch__indicator.fui-Switch__indicator {
  --winui-switch-travel-duration: 0s;
}

.fui-Switch[data-winui-switch-dragging].fui-Switch .fui-Switch__indicator.fui-Switch__indicator > * {
  transform: translateX(var(--winui-switch-drag-x));
}

.fui-Switch[data-winui-switch-settling] .fui-Switch__indicator.fui-Switch__indicator {
  --winui-switch-crossfade-duration: var(--winui-control-faster-animation-duration);
}

/* Both capsules span the indicator's border box, which their -1px inset reaches
   from the padding box they are positioned against. */
.fui-Switch__indicator.fui-Switch__indicator::before,
.fui-Switch__indicator.fui-Switch__indicator::after {
  border-radius: inherit;
  box-sizing: border-box;
  content: '';
  inset: -1px;
  position: absolute;
  transition-duration: var(--winui-switch-crossfade-duration);
  transition-property: opacity;
  transition-timing-function: linear;
}

/* OuterBorder. Its fill and stroke are the ones that respond to the pointer,
   over ControlFasterAnimationDuration on LinearColorKeyFrames -- WinUI holds the
   stroke at ToggleSwitchStrokeOff across hover and press, so only the fill ramp
   moves and the stroke transition is here for the disabled edge alone.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleSwitch_themeresources.xaml#L135-L142 */
.fui-Switch__indicator.fui-Switch__indicator::before {
  background-color: var(--winui-control-alt-fill-secondary);
  border: 1px solid var(--winui-control-strong-stroke-default);
  transition-duration: var(--winui-control-faster-animation-duration), var(--winui-control-faster-animation-duration), var(--winui-switch-crossfade-duration);
  transition-property: background-color, border-color, opacity;
}

/* SwitchKnobBounds. Its brushes are swapped by ObjectAnimationUsingKeyFrames
   rather than interpolated, so the accent ramp lands instantly and only the
   opacity above carries any timing. WinUI draws its stroke in the same accent as
   its fill, which a single filled capsule already is.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleSwitch_themeresources.xaml#L143-L150
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleSwitch_themeresources.xaml#L259-L263 */
.fui-Switch__indicator.fui-Switch__indicator::after {
  background-color: var(--winui-accent-fill-default);
  opacity: 0;
}

.fui-Switch__input:checked ~ .fui-Switch__indicator.fui-Switch__indicator::before {
  opacity: 0;
}

.fui-Switch__input:checked ~ .fui-Switch__indicator.fui-Switch__indicator::after {
  opacity: 1;
}

/* Fluent paints the indicator itself in every checked and disabled state, at a
   specificity the base rule above cannot reach. Left standing, that fill sits
   between the two capsules and is what shows through the moment neither is
   opaque -- the wash mid-cross-fade would be Fluent's brand blue instead of the
   page. */
.fui-Switch__input:enabled:checked:not([aria-disabled='true']) ~ .fui-Switch__indicator.fui-Switch__indicator,
.fui-Switch__input:enabled:checked:not([aria-disabled='true']):hover ~ .fui-Switch__indicator.fui-Switch__indicator,
.fui-Switch__input:enabled:checked:not([aria-disabled='true']):hover:active ~ .fui-Switch__indicator.fui-Switch__indicator,
.fui-Switch__input:disabled:checked ~ .fui-Switch__indicator.fui-Switch__indicator,
.fui-Switch__input[aria-disabled='true']:checked ~ .fui-Switch__indicator.fui-Switch__indicator {
  background-color: transparent;
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
  border-radius: 999px;
  height: calc(12 * var(--winui-switch-unit));
  margin-inline-start: calc(2.5 * var(--winui-switch-unit));
  /* Above both capsules. Positioned children paint in tree order against a
     positioned sibling, which would put the accent one over the knob. */
  position: relative;
  z-index: 1;
  /* Three animations, not one. The size and the margin are the template's own
     keyframes: ControlFasterAnimationDuration on the fast-out-slow-in spline,
     stated outright for Width and Height in the PointerOver and Pressed states.

     The travel is the template's second animation. Toggling states
     KnobTranslateTransform with Duration="0" and hands the movement to a
     RepositionThemeAnimation, whose timing the OS supplies rather than the
     template -- transcribed in ../motion.ts, where it is sourced.

     The fill is the third. It stands in for the cross-fade of the two knobs
     XAML stacks the same way it stacks the two tracks, so it runs on that
     cross-fade's asymmetric duration -- see the header for what an
     interpolating fill does and does not carry of it.

     Travel and size run 4.4x apart, and that ratio is the control's whole
     character: the knob crosses the track deliberately while its swell under the
     pointer, and the colour under it, are accents that have already finished.
     Matching their durations, tried here first, reads as the knob lunging.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleSwitch_themeresources.xaml#L443-L446 */
  transition-duration: var(--winui-control-faster-animation-duration), var(--winui-control-faster-animation-duration), var(--winui-control-faster-animation-duration), var(--winui-switch-travel-duration), var(--winui-switch-crossfade-duration);
  transition-property: width, height, margin-inline-start, transform, background-color;
  transition-timing-function: var(--winui-control-fast-out-slow-in-easing), var(--winui-control-fast-out-slow-in-easing), var(--winui-control-fast-out-slow-in-easing), var(--winui-reposition-easing), linear;
  width: calc(12 * var(--winui-switch-unit));
}

/* Fluent clamps its own switch transitions under reduced motion, but at a
   single class, so every timing declared above outranks it. The clamp is
   restated here at the weight those rules carry. 0.01ms rather than none for
   the reason ./choice.css.ts records at the same construction: the transition
   still has to complete. */
@media (prefers-reduced-motion: reduce) {
  .fui-Switch__indicator.fui-Switch__indicator::before,
  .fui-Switch__indicator.fui-Switch__indicator::after,
  .fui-Switch__indicator.fui-Switch__indicator > * {
    transition-duration: 0.01ms;
  }
}

/* The knob's own fill, stated per state rather than taken from the indicator's
   colour. XAML stacks SwitchKnobOff under SwitchKnobOn and cross-fades their
   opacities exactly as it does the two tracks, so this fill has to animate on
   the same schedule; \`currentColor\` cannot, because it resolves at used-value
   time and leaves background-color with no interpolable endpoints -- the knob
   would jump the moment the indicator's colour did.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleSwitch_themeresources.xaml#L152-L158 */
.fui-Switch__indicator.fui-Switch__indicator > * {
  background-color: var(--winui-text-fill-secondary);
}

.fui-Switch__input:checked ~ .fui-Switch__indicator.fui-Switch__indicator > * {
  background-color: var(--winui-text-on-accent-fill-primary);
}

.fui-Switch__input:disabled:not(:checked) ~ .fui-Switch__indicator.fui-Switch__indicator > *,
.fui-Switch__input[aria-disabled='true']:not(:checked) ~ .fui-Switch__indicator.fui-Switch__indicator > * {
  background-color: var(--winui-text-fill-disabled);
}

.fui-Switch__input:disabled:checked ~ .fui-Switch__indicator.fui-Switch__indicator > *,
.fui-Switch__input[aria-disabled='true']:checked ~ .fui-Switch__indicator.fui-Switch__indicator > * {
  background-color: var(--winui-text-on-accent-fill-disabled);
}

/* Off: WinUI puts the whole pointer response on the track fill and holds both
   the stroke (ToggleSwitchStrokeOff) and the knob (TextFillColorSecondary) at
   their rest values, so the alt-fill ramp is the only thing hover and press
   move.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleSwitch_themeresources.xaml#L135-L141
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleSwitch_themeresources.xaml#L151-L153 */
.fui-Switch__input:enabled:not(:checked):not([aria-disabled='true']):hover ~ .fui-Switch__indicator.fui-Switch__indicator::before {
  background-color: var(--winui-control-alt-fill-tertiary);
}

.fui-Switch__input:enabled:not(:checked):not([aria-disabled='true']):hover:active ~ .fui-Switch__indicator.fui-Switch__indicator::before {
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
   track does -- and keyed off the input these rules never fired at all. A drag
   selects the same geometry outright, because ChangeVisualState answers Pressed
   for the whole gesture and :active alone would not survive the pointer leaving
   the control.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleSwitch_themeresources.xaml#L231-L242
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleSwitch_themeresources.xaml#L245-L324
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/lib/ToggleSwitch_Partial.cpp#L63-L72 */
.fui-Switch:hover .fui-Switch__input:enabled:not([aria-disabled='true']) ~ .fui-Switch__indicator.fui-Switch__indicator > *,
.fui-Switch[data-winui-switch-dragging] .fui-Switch__input:enabled:not([aria-disabled='true']) ~ .fui-Switch__indicator.fui-Switch__indicator > * {
  height: calc(14 * var(--winui-switch-unit));
  margin-inline-start: calc(1.5 * var(--winui-switch-unit));
  width: calc(14 * var(--winui-switch-unit));
}

.fui-Switch:active .fui-Switch__input:enabled:not([aria-disabled='true']) ~ .fui-Switch__indicator.fui-Switch__indicator > *,
.fui-Switch[data-winui-switch-dragging] .fui-Switch__input:enabled:not([aria-disabled='true']) ~ .fui-Switch__indicator.fui-Switch__indicator > * {
  margin-inline-start: calc(2 * var(--winui-switch-unit));
  width: calc(17 * var(--winui-switch-unit));
}

.fui-Switch:active .fui-Switch__input:enabled:checked:not([aria-disabled='true']) ~ .fui-Switch__indicator.fui-Switch__indicator > *,
.fui-Switch[data-winui-switch-dragging] .fui-Switch__input:enabled:checked:not([aria-disabled='true']) ~ .fui-Switch__indicator.fui-Switch__indicator > * {
  margin-inline-start: calc(-1 * var(--winui-switch-unit));
}

/* On: the accent fill ramp, on the capsule that carries it. */
.fui-Switch__input:enabled:checked:not([aria-disabled='true']):hover ~ .fui-Switch__indicator.fui-Switch__indicator::after {
  background-color: var(--winui-accent-fill-secondary);
}

.fui-Switch__input:enabled:checked:not([aria-disabled='true']):hover:active ~ .fui-Switch__indicator.fui-Switch__indicator::after {
  background-color: var(--winui-accent-fill-tertiary);
}

/* Disabled. Off keeps its stroke and loses its fill -- ToggleSwitchFillOffDisabled
   is fully transparent in both dictionaries -- while on holds the disabled
   accent; the knob follows the matching disabled foreground in each. WinUI also
   returns the knob to its rest size, which no pointer state can reach here.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleSwitch_themeresources.xaml#L138-L139
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleSwitch_themeresources.xaml#L146-L158
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleSwitch_themeresources.xaml#L357-L368 */
.fui-Switch__input:disabled:not(:checked) ~ .fui-Switch__indicator.fui-Switch__indicator::before,
.fui-Switch__input[aria-disabled='true']:not(:checked) ~ .fui-Switch__indicator.fui-Switch__indicator::before {
  background-color: var(--winui-control-alt-fill-disabled);
  border-color: var(--winui-control-strong-stroke-disabled);
}

.fui-Switch__input:disabled:checked ~ .fui-Switch__indicator.fui-Switch__indicator::after,
.fui-Switch__input[aria-disabled='true']:checked ~ .fui-Switch__indicator.fui-Switch__indicator::after {
  background-color: var(--winui-accent-fill-disabled);
}

/* Focus: Fluent already draws a 2px ring around the whole control, so its colour
   becomes FocusStrokeColorOuter and the 1px FocusStrokeColorInner ring WinUI
   backs it with is added inside it. Those two thicknesses are the framework
   defaults for FocusVisualPrimaryThickness and FocusVisualSecondaryThickness.
   What is not transcribed is the FocusVisualMargin of -7,-3,-7,-3, which
   inflates the pair around SwitchAreaGrid: that margin is stated against a
   template part, and the ring here belongs to the whole control, so the
   inflation stays as Fluent draws it.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleSwitch_themeresources.xaml#L200
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L258-L259
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/components/DependencyObject/DependencyProperty.cpp#L22-L25 */
.fui-Switch.fui-Switch[data-fui-focus-within]:focus-within::after {
  border-color: var(--winui-focus-stroke-outer);
  box-shadow: inset 0 0 0 1px var(--winui-focus-stroke-inner);
}
`;
