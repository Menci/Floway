// Switch restyled as WinUI 3's ToggleSwitch. Fluent's medium track already
// matches WinUI's OuterBorder, so the track box carries over and only the knob
// and the paint are restated: WinUI's knob is a 12x12 rectangle in a 20x20
// cell where Fluent's is a circle glyph filling the track height, so we keep
// Fluent's element and its translate, blank the glyph, and paint the knob as
// the element's own box.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleSwitch_themeresources.xaml#L507-L521
//
// The track is two stacked capsules, not one: XAML cross-fades OuterBorder
// against SwitchKnobBounds, and a single element interpolating one
// background-color travels straight between the two fills instead of washing
// out towards the page half way through, so the pair is reproduced as the
// indicator's two pseudo-elements.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleSwitch_themeresources.xaml#L507-L508
//
// Knob sizes and gaps are multiples of a unit the size sets, so Fluent's small
// track — which WinUI has no counterpart for — keeps the same proportions: at
// medium's literal 12px the small knob finished half a pixel past the track's
// inner edge. Every offset below is stated relative to the track's outer edge
// and then reduced by the 1px border the content box is inset by.
//
// The knob is the one subject the doubling convention cannot be applied to.
// Fluent gives it no class of its own, addressing it as `> *` from the
// indicator's reset class, so every knob rule here doubles the indicator
// instead. It is named by element rather than by that reach: useSwitch fills
// the indicator slot with CircleFilled, and a mono-colour react-icons glyph is
// one svg holding one path, so `> svg` and `> svg > path` are the two elements
// that exist (@fluentui/react-switch useSwitch, @fluentui/react-icons
// renderSvgBody).
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-switch/library/src/components/Switch/useSwitchStyles.styles.ts#L74-L82
//
// XAML centres both knobs at the same 3.5px inside a cell that translates by
// 20px, so one translated element carries both positions. It does not carry
// their cross-fade: Fluent's knob is an SVG element, and an SVG element
// generates no ::before or ::after box to stack a second knob in.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleSwitch_themeresources.xaml#L510-L520
//
// Colour is confined to `@media not (forced-colors: active)`: a Highlight
// capsule would need `forced-color-adjust: none` on the pseudo-elements, which
// this layer chooses not to take on, so under forced colours the paint below
// drops out and Fluent's own drawing shows through. Geometry, motion and the
// knob's travel apply in both modes.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleSwitch_themeresources.xaml#L64-L123

import { nested, notDisabled, pressedRoots, reducedMotion, under } from './selectors';

// The two pointer states are answered from the root, never from the input:
// Fluent's input covers the track alone, so a label beside it is hovered
// without the input being. A drag adds itself to both, because
// ChangeVisualState answers PointerOver and then Pressed for the whole
// gesture, and the geometry and the paint read the same two lists.
const hoverRoots = [
  '.fui-Switch:hover',
  '.fui-Switch[data-winui-switch-dragging]',
];

const switchPressedRoots = [
  ...pressedRoots('.fui-Switch', '.fui-Switch__input'),
  '.fui-Switch[data-winui-switch-dragging]',
];

const enabledKnob = `.fui-Switch__input${notDisabled}`
  + ' ~ .fui-Switch__indicator.fui-Switch__indicator > svg';

const enabledCheckedKnob = `.fui-Switch__input${notDisabled}:checked`
  + ' ~ .fui-Switch__indicator.fui-Switch__indicator > svg';

const offTrack = `.fui-Switch__input${notDisabled}:not(:checked)`
  + ' ~ .fui-Switch__indicator.fui-Switch__indicator::before';

const onTrack = `.fui-Switch__input${notDisabled}:checked`
  + ' ~ .fui-Switch__indicator.fui-Switch__indicator::after';

export const switchCss = `
/* ManipulationMode="System,TranslateX" claims the horizontal axis for the
   control and leaves the vertical one to the scroller above it, which is what
   touch-action: pan-y says here.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleSwitch_themeresources.xaml#L524-L528 */
.fui-Switch.fui-Switch {
  touch-action: pan-y;
}

/* The indicator paints nothing and animates nothing: the two capsules below
   carry the fill and stroke, and the knob paints its own. */
.fui-Switch__indicator.fui-Switch__indicator {
  align-items: center;
  align-self: center;
  display: flex;
  /* Fluent's own eight-pixel inline ring is dropped for the twelve the
     template's gap column states, declared on the root because that is the only
     form which survives the label moving to either side; WinUI's 40px block
     body is dropped so the switch runs at the one control-row height this app's
     forms share.
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

/* Fluent's label padding is the last thing holding the root taller than the
   track, so it goes with the indicator's block margin. */
.fui-Switch__label.fui-Switch__label {
  padding: 0;
}

/* A labelled switch is a field standing beside inputs and combo boxes, so it
   takes the row height those share; one that does not is only itself. Both the
   34 (written down in ./text-input.css.ts) and the gate are this app's choice --
   WinUI states 40 for every switch, labelled or not. */
.fui-Switch.fui-Switch:has(> .fui-Switch__label) {
  min-height: 34px;
}

/* Turning on cross-fades the two capsules linearly over
   ControlFasterAnimationDuration; turning off does not fade at all --
   OnToOffTransition carries GeneratedDuration 0 and the Off state is empty. So
   the one duration declared here is the on direction's.
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

/* Dragging. The knob is glued to the pointer -- XAML writes
   KnobTranslateTransform.X on every DragDelta with no storyboard behind it --
   so the travel transition is switched off for the length of the gesture and
   the position comes in as a custom property the drag writes.

   Settling out of a drag does fade, in both directions. That is the one place
   the off direction is not instant: DraggingToOffTransition carries the same
   four 83ms opacity keyframes DraggingToOnTransition does, where
   OnToOffTransition -- the click path -- carries none.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleSwitch_themeresources.xaml#L391-L403
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleSwitch_themeresources.xaml#L404-L417 */
.fui-Switch[data-winui-switch-dragging] .fui-Switch__indicator.fui-Switch__indicator {
  --winui-switch-travel-duration: 0s;
}

.fui-Switch[data-winui-switch-dragging] .fui-Switch__indicator.fui-Switch__indicator > svg {
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

/* OuterBorder. WinUI holds the stroke at ToggleSwitchStrokeOff across hover and
   press, so only the fill ramp moves and the stroke transition is here for the
   disabled edge alone.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleSwitch_themeresources.xaml#L135-L142 */
.fui-Switch__indicator.fui-Switch__indicator::before {
  transition-duration: var(--winui-control-faster-animation-duration), var(--winui-control-faster-animation-duration), var(--winui-switch-crossfade-duration);
  transition-property: background-color, border-color, opacity;
}

/* SwitchKnobBounds, the accent capsule. Its brushes are swapped by
   ObjectAnimationUsingKeyFrames rather than interpolated, so the accent ramp
   lands instantly and only the opacity here carries any timing.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleSwitch_themeresources.xaml#L143-L150
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleSwitch_themeresources.xaml#L259-L263 */
.fui-Switch__indicator.fui-Switch__indicator::after {
  opacity: 0;
}

.fui-Switch__input:checked ~ .fui-Switch__indicator.fui-Switch__indicator::before {
  opacity: 0;
}

.fui-Switch__input:checked ~ .fui-Switch__indicator.fui-Switch__indicator::after {
  opacity: 1;
}

.fui-Switch__indicator.fui-Switch__indicator > svg {
  /* WinUI over-specifies the knob radius as 7 on a 12x12 box -- CornerRadius on
     the on-knob, RadiusX and RadiusY on the off-knob -- so XAML clamps it to a
     circle. A radius past half the box clamps the same way here, and it stays
     correct through the swell and the pressed capsule, where a stated 7 would
     leave the ends squarer than the template draws them.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleSwitch_themeresources.xaml#L510
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleSwitch_themeresources.xaml#L515 */
  border-radius: 999px;
  height: calc(12 * var(--winui-switch-unit));
  margin-inline-start: calc(2.5 * var(--winui-switch-unit));
  /* Above both capsules. Positioned children paint in tree order against a
     positioned sibling, which would put the accent one over the knob. */
  position: relative;
  z-index: 1;
  /* Three animations, not one: size and margin on the template's own keyframes,
     travel on the RepositionThemeAnimation timing the OS supplies (transcribed
     in ../motion.ts), and the fill standing in for the cross-fade of the two
     stacked knobs, on that cross-fade's asymmetric duration.

     Travel and size run 4.4x apart, and that ratio is the control's whole
     character: the knob crosses the track deliberately while its swell under
     the pointer is an accent that has already finished. Matching their
     durations, tried here first, reads as the knob lunging.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleSwitch_themeresources.xaml#L443-L446 */
  transition-duration: var(--winui-control-faster-animation-duration), var(--winui-control-faster-animation-duration), var(--winui-control-faster-animation-duration), var(--winui-switch-travel-duration), var(--winui-switch-crossfade-duration);
  transition-property: width, height, margin-inline-start, transform, background-color;
  transition-timing-function: var(--winui-control-fast-out-slow-in-easing), var(--winui-control-fast-out-slow-in-easing), var(--winui-control-fast-out-slow-in-easing), var(--winui-reposition-easing), linear;
  width: calc(12 * var(--winui-switch-unit));
}

/* The knob swells to 14x14 under the pointer and stretches to 17x14 while
   pressed -- a capsule, not a circle, which is why the shape is the element's
   own background rather than a glyph. The template animates Width and Height
   themselves rather than a scale, so the margins stated with each size are what
   keep the growth centred on the track's leading edge until the press pushes it
   3px along, mirrored to a negative one once the knob has travelled.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleSwitch_themeresources.xaml#L231-L242
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleSwitch_themeresources.xaml#L245-L324
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/lib/ToggleSwitch_Partial.cpp#L63-L72 */
${under(hoverRoots, [enabledKnob])} {
  height: calc(14 * var(--winui-switch-unit));
  margin-inline-start: calc(1.5 * var(--winui-switch-unit));
  width: calc(14 * var(--winui-switch-unit));
}

/* Pressed states its own height as well as its width. Both are 14 under the
   pointer, but the press is reachable without the hover that would otherwise
   supply it -- Space on the focused input, and a drag that has carried the
   pointer off the control -- and a 17x12 knob is a shape the template never
   draws. */
${under(switchPressedRoots, [enabledKnob])} {
  height: calc(14 * var(--winui-switch-unit));
  margin-inline-start: calc(2 * var(--winui-switch-unit));
  width: calc(17 * var(--winui-switch-unit));
}

${under(switchPressedRoots, [enabledCheckedKnob])} {
  margin-inline-start: calc(-1 * var(--winui-switch-unit));
}

/* Fluent clamps its own switch transitions under reduced motion, but at a
   single class, so every timing declared above outranks it. */
${reducedMotion([
  '.fui-Switch__indicator.fui-Switch__indicator::before',
  '.fui-Switch__indicator.fui-Switch__indicator::after',
  '.fui-Switch__indicator.fui-Switch__indicator > svg',
], 'transition-duration')}

@media not (forced-colors: active) {
  /* The indicator paints neither fill nor stroke of its own. Fluent states both
     on the input's reset atom, once per pointer and disabled state, at a
     specificity a plain doubled subject cannot reach, so every one of those
     states is answered here. Both matter: the fill is what shows through the
     moment neither capsule is opaque, and the stroke is a second ring one pixel
     outside the capsule's own, which appears in that same window when a drag
     settles back to off. The subject is Fluent's own :hover:active rather than
     the pressed union ./selectors.ts defines, because these rules only cancel
     Fluent atoms, which stop matching in exactly the conditions that chain
     does. */
  .fui-Switch__indicator.fui-Switch__indicator,
  .fui-Switch__input${notDisabled}:not(:checked) ~ .fui-Switch__indicator.fui-Switch__indicator,
  .fui-Switch__input${notDisabled}:not(:checked):hover ~ .fui-Switch__indicator.fui-Switch__indicator,
  .fui-Switch__input${notDisabled}:not(:checked):hover:active ~ .fui-Switch__indicator.fui-Switch__indicator,
  .fui-Switch__input${notDisabled}:checked ~ .fui-Switch__indicator.fui-Switch__indicator,
  .fui-Switch__input${notDisabled}:checked:hover ~ .fui-Switch__indicator.fui-Switch__indicator,
  .fui-Switch__input${notDisabled}:checked:hover:active ~ .fui-Switch__indicator.fui-Switch__indicator,
  .fui-Switch__input:disabled:not(:checked) ~ .fui-Switch__indicator.fui-Switch__indicator,
  .fui-Switch__input[aria-disabled='true']:not(:checked) ~ .fui-Switch__indicator.fui-Switch__indicator,
  .fui-Switch__input:disabled:checked ~ .fui-Switch__indicator.fui-Switch__indicator,
  .fui-Switch__input[aria-disabled='true']:checked ~ .fui-Switch__indicator.fui-Switch__indicator {
    background-color: transparent;
    border-color: transparent;
  }

  /* OuterBorder's rest fill and stroke.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleSwitch_themeresources.xaml#L135
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleSwitch_themeresources.xaml#L139 */
  .fui-Switch__indicator.fui-Switch__indicator::before {
    background-color: var(--winui-control-alt-fill-secondary);
    border: 1px solid var(--winui-control-strong-stroke-default);
  }

  /* WinUI draws SwitchKnobBounds' stroke in the same accent as its fill, which
     a single filled capsule already is.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleSwitch_themeresources.xaml#L143
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleSwitch_themeresources.xaml#L147 */
  .fui-Switch__indicator.fui-Switch__indicator::after {
    background-color: var(--winui-accent-fill-default);
  }

  /* Fluent's glyph has to go, or it shows through as a second, circular knob
     inside the one this file paints. \`fill\` on the SVG does not reach the path
     that draws it, so the path is named. */
  .fui-Switch__indicator.fui-Switch__indicator > svg > path {
    fill: transparent;
  }

  /* The knob's own fill, stated per state rather than taken from the
     indicator's colour. It has to animate on the cross-fade's schedule, and
     \`currentColor\` cannot: it resolves at used-value time and leaves
     background-color with no interpolable endpoints, so the knob would jump the
     moment the indicator's colour did.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleSwitch_themeresources.xaml#L151-L158 */
  .fui-Switch__indicator.fui-Switch__indicator > svg {
    background-color: var(--winui-text-fill-secondary);
  }

  .fui-Switch__input:checked ~ .fui-Switch__indicator.fui-Switch__indicator > svg {
    background-color: var(--winui-text-on-accent-fill-primary);
  }

  .fui-Switch__input:disabled:not(:checked) ~ .fui-Switch__indicator.fui-Switch__indicator > svg,
  .fui-Switch__input[aria-disabled='true']:not(:checked) ~ .fui-Switch__indicator.fui-Switch__indicator > svg {
    background-color: var(--winui-text-fill-disabled);
  }

  .fui-Switch__input:disabled:checked ~ .fui-Switch__indicator.fui-Switch__indicator > svg,
  .fui-Switch__input[aria-disabled='true']:checked ~ .fui-Switch__indicator.fui-Switch__indicator > svg {
    background-color: var(--winui-text-on-accent-fill-disabled);
  }

  /* Off: WinUI puts the whole pointer response on the track fill and holds the
     stroke and the knob at their rest values.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleSwitch_themeresources.xaml#L136-L137
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleSwitch_themeresources.xaml#L140-L141 */
${nested(under(hoverRoots, [offTrack]))} {
    background-color: var(--winui-control-alt-fill-tertiary);
  }

${nested(under(switchPressedRoots, [offTrack]))} {
    background-color: var(--winui-control-alt-fill-quarternary);
  }

  /* On: the accent fill ramp, on the capsule that carries it.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleSwitch_themeresources.xaml#L144-L145 */
${nested(under(hoverRoots, [onTrack]))} {
    background-color: var(--winui-accent-fill-secondary);
  }

${nested(under(switchPressedRoots, [onTrack]))} {
    background-color: var(--winui-accent-fill-tertiary);
  }

  /* Disabled. WinUI returns the knob to its rest size, which needs no rule here:
     every size rule above is gated on the input being enabled.
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

  /* Focus. WinUI's FocusVisualMargin of -7,-3,-7,-3 is not transcribed: it
     inflates the ring around a template part, where this ring belongs to the
     whole control, so the inflation stays as Fluent draws it.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleSwitch_themeresources.xaml#L200
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L258-L259
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/components/DependencyObject/DependencyProperty.cpp#L22-L25 */
  .fui-Switch.fui-Switch[data-fui-focus-within]:focus-within::after {
    border-color: var(--winui-focus-stroke-outer);
    box-shadow: inset 0 0 0 var(--winui-focus-visual-secondary-thickness) var(--winui-focus-stroke-inner);
  }
}
`;
