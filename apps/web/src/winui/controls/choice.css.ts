// Checkbox and Radio, restyled from the Fluent 2 Web look to WinUI 3.
//
// WinUI paints the selected state as a filled accent shape carrying a light
// glyph, where Fluent leaves the box hollow and tints the glyph itself. Border
// and glyph swap roles on selection, so the selected rules restate background,
// border and glyph together rather than adjusting one; the check box's own
// surface table lives in ./checkbox-surface.ts, which every slot in this layer
// that draws a box shares, and the ellipse's is stated below.
// The indicator element is painted directly rather than through Fluent's
// `--fui-Checkbox__indicator--*` custom properties, so one rule can cover the
// Fluent states sharing a single WinUI value.
//
// Colour is confined to `@media not (forced-colors: active)`: an accent-filled
// indicator under forced colours would need `forced-color-adjust: none`, which
// this layer chooses not to take on, so forced colours keeps Fluent's drawing.
// The box geometry applies in both modes; the check box's two marks do not,
// because they are painted as a currentColor fill through a mask and a forced
// palette would flatten them, so forced colours keeps drawing Fluent's own
// glyph.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L92-L179
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L62-L119

import { checkboxSurfaceCss } from './checkbox-surface';
import { list, nested, pressedRoots, reducedMotion, under } from './selectors';

// The check box's marks. WinUI does not draw a font character: the template's
// CheckGlyph is an AnimatedIcon over AnimatedAcceptVisualSource, and both the
// check and the indeterminate dash are open, round-capped polylines stroked at
// four units. CheckBoxGlyphSize of 12 sizes only the FontIconSource fallback,
// so it is not the shipped mark's measure -- the check is 10.6 x 7.6 and the
// dash 8.5 x 1.3 in the 20px box, both at the same 1.23px stroke.
//
// The two marks and their boxes are generated from the upstream coordinates so
// the drawn size cannot drift from the path. Each sprite is placed on its own
// origin, so a mark's box is its widest coordinate on each axis plus half the
// stroke, mirrored; that keeps the box centred where XAML centres the sprite.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L602-L609
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/AnimatedIcon/AnimatedVisuals/AnimatedAcceptVisualSource.cpp#L358-L386
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/AnimatedIcon/AnimatedVisuals/AnimatedAcceptVisualSource.cpp#L560-L571
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/AnimatedIcon/AnimatedVisuals/AnimatedAcceptVisualSource.cpp#L755-L770
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/AnimatedIcon/AnimatedVisuals/AnimatedAcceptVisualSource.cpp#L1283-L1293
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/AnimatedIcon/AnimatedVisuals/AnimatedAcceptVisualSource.cpp#L1855-L1858
const BOX_PX = 20;
const COMPOSITION_VIEWPORT = 48;
const GLYPH_SPRITE_SCALE = 0.7;
const GLYPH_CONTAINER_SCALE = 1.05;
const GLYPH_STROKE = 4;

const CHECK_POINTS = [[-15.172, 0.016], [-5, 10.188], [15.337, -10.337]] as const;
const DASH_POINTS = [[-11.75, -0.125], [11.875, -0.125]] as const;

// Four decimals is far below what a device pixel can carry and keeps binary
// floating point noise out of the sheet.
const exact = (value: number) => Number(value.toFixed(4));

// AnimatedIcon scales the composition uniformly onto the box it is arranged in.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/AnimatedIcon/AnimatedIcon.cpp#L115-L119
const glyphPx = (units: number) =>
  `${exact(units * GLYPH_SPRITE_SCALE * GLYPH_CONTAINER_SCALE * BOX_PX / COMPOSITION_VIEWPORT)}px`;

const glyphMark = (points: readonly (readonly [number, number])[]) => {
  const half = (axis: 0 | 1) => Math.max(...points.map(point => Math.abs(point[axis]))) + GLYPH_STROKE / 2;
  const [halfWidth, halfHeight] = [half(0), half(1)];
  const path = points.map(([x, y], index) => `${index === 0 ? 'M' : 'L'} ${x} ${y}`).join(' ');
  const svg = `<svg xmlns='http://www.w3.org/2000/svg'`
    + ` viewBox='${-halfWidth} ${-halfHeight} ${halfWidth * 2} ${halfHeight * 2}'>`
    + `<path d='${path}' fill='none' stroke='white' stroke-width='${GLYPH_STROKE}'`
    + ` stroke-linecap='round' stroke-linejoin='round'/></svg>`;
  return {
    width: glyphPx(halfWidth * 2),
    height: glyphPx(halfHeight * 2),
    image: `url("data:image/svg+xml,${svg.replaceAll('<', '%3C').replaceAll('>', '%3E')}")`,
  };
};

const check = glyphMark(CHECK_POINTS);
const dash = glyphMark(DASH_POINTS);

// The template offsets the whole glyph one pixel down, which the four
// indeterminate states then take back; the check's own sprite sits a unit above
// the composition centre, where the dash's sits on it.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L604
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L505
const CHECK_SPRITE_ORIGIN_Y = 23;
const checkOffset = `${exact(1 - (COMPOSITION_VIEWPORT / 2 - CHECK_SPRITE_ORIGIN_Y)
  * GLYPH_CONTAINER_SCALE * BOX_PX / COMPOSITION_VIEWPORT)}px`;

// AnimatedIcon plays the marker-bounded slice of the composition, whose ticks
// are hundreds of nanoseconds, at one to one. The check draws on over TrimEnd
// and erases over TrimStart, so the two directions carry their own durations
// and easings rather than one being the reverse of the other.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/AnimatedIcon/AnimatedIcon.cpp#L420-L451
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/AnimatedIcon/AnimatedVisuals/AnimatedAcceptVisualSource.cpp#L1945-L1952
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/AnimatedIcon/AnimatedVisuals/AnimatedAcceptVisualSource.cpp#L1930-L1933
const COMPOSITION_MS = 26666666 / 10000;
const CHECK_ON_MS = `${exact((0.2128125 - 0.0940625) * COMPOSITION_MS)}ms`;
const CHECK_OFF_MS = `${exact(0.0253125 * COMPOSITION_MS)}ms`;
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/AnimatedIcon/AnimatedVisuals/AnimatedAcceptVisualSource.cpp#L1471-L1479
const CHECK_ON_BEZIER = [0.55, 0, 0, 1] as const;
const CHECK_ON_EASING = `cubic-bezier(${CHECK_ON_BEZIER.join(', ')})`;
const CHECK_OFF_EASING = 'cubic-bezier(0.167, 0.167, 0.833, 0.833)';

const cubicCoordinate = (time: number, first: number, second: number) =>
  3 * (1 - time) ** 2 * time * first + 3 * (1 - time) * time ** 2 * second + time ** 3;

const cubicOutputAt = ([x1, y1, x2, y2]: readonly [number, number, number, number], progress: number) => {
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 60; iteration += 1) {
    const time = (low + high) / 2;
    if (cubicCoordinate(time, x1, x2) < progress) low = time; else high = time;
  }
  return cubicCoordinate((low + high) / 2, y1, y2);
};

// Chromium 150-152 can loop forever while finding the range of this cubic
// timing function for a composited clip-path transition. Forty straight
// segments keep the largest progress error below 0.005 -- under 0.06px across
// this mark -- while routing supporting browsers through LinearTimingFunction.
// The cubic remains the fallback for engines that do not parse linear().
// https://issues.chromium.org/issues/536936875
// https://chromium-review.googlesource.com/c/chromium/src/+/8152879
// https://drafts.csswg.org/css-easing-2/#the-linear-easing-function
const CHECK_ON_LINEAR_SEGMENTS = 40;
const CHECK_ON_LINEAR_EASING = `linear(${Array.from(
  { length: CHECK_ON_LINEAR_SEGMENTS + 1 },
  (_, index) => exact(cubicOutputAt(CHECK_ON_BEZIER, index / CHECK_ON_LINEAR_SEGMENTS)),
).join(', ')})`;

// The tri-state check box is named by the data-winui-checked stamp
// ../appearance.ts applies, never by :indeterminate -- that module carries why
// the property cannot be read. Both halves of the test are stated here and
// consumed by every rule that distinguishes the state, ./list.css.ts included,
// so no sheet reaches for the property again.
export const checkboxMixed = "[data-winui-checked='mixed']";
export const checkboxNotMixed = `:not(${checkboxMixed})`;

const checkboxPressed = pressedRoots('.fui-Checkbox', '.fui-Checkbox__input');
const radioPressed = pressedRoots('.fui-Radio', '.fui-Radio__input');

// The Checkbox DOM shape is stated here for every sheet that answers a check
// box, ./list.css.ts included, so no other sheet spells the slot out again.
const indicator = '.fui-Checkbox__indicator.fui-Checkbox__indicator';
const box = (input: string) => `.fui-Checkbox__input${input} ~ ${indicator}`;

export const uncheckedBox = box(`:enabled:not(:checked)${checkboxNotMixed}`);

const selectedBoxes = [box(':enabled:checked'), box(`:enabled${checkboxMixed}`)];
const selectedDisabledBoxes = [box(':disabled:checked'), box(`:disabled${checkboxMixed}`)];

const hoveredCheckbox = ['.fui-Checkbox:hover'];

const uncheckedEllipse = '.fui-Radio__input:enabled:not(:checked)'
  + ' ~ .fui-Radio__indicator.fui-Radio__indicator';

const selectedEllipse = '.fui-Radio__input:enabled:checked'
  + ' ~ .fui-Radio__indicator.fui-Radio__indicator';

const selectedDot = `${selectedEllipse}::after`;

export const choiceCss = `
/* Check box geometry. The corner radius has to be stated: Fluent's indicator reset
   reads \`borderRadiusSmall\`, which the theme layer leaves on Fluent's own 2px
   because no WinUI radius is that small.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L270-L271
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L294
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L603
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CornerRadius_themeresources.xaml#L13-L15 */
.fui-Checkbox__indicator.fui-Checkbox__indicator {
  border-radius: var(--winui-control-corner-radius);
  width: 20px;
  height: 20px;
  /* WinUI centres the box in the control, where Fluent pins it to the top so
     it meets the first line of a wrapping label.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L602 */
  align-self: center;
  margin: 0;
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
   holding the root taller than what it draws. The block margins go the same way:
   Fluent pulls the label in by half the difference between its indicator and the
   line box, sized for a 16px indicator at medium and a 20px one at large, so at
   our single 20px box the pull resolves to zero and the two sizes stop
   disagreeing. */
.fui-Checkbox__label.fui-Checkbox__label,
.fui-Radio__label.fui-Radio__label {
  padding: 0;
  margin-top: calc((20px - var(--lineHeightBase300)) / 2);
  margin-bottom: calc((20px - var(--lineHeightBase300)) / 2);
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

  /* The box's own surface, on the shared table ./checkbox-surface.ts states.
     The check box addresses it from the input, so every state is a pseudo-class
     on that input, with pointer-over and pressed read from the root because
     WinUI makes them states of the whole control. */
${nested(checkboxSurfaceCss({
  unchecked: uncheckedBox,
  uncheckedHovered: under(hoveredCheckbox, [uncheckedBox]),
  uncheckedPressed: under(checkboxPressed, [uncheckedBox]),
  uncheckedDisabled: box(`:disabled:not(:checked)${checkboxNotMixed}`),
  selected: list(selectedBoxes),
  selectedHovered: under(hoveredCheckbox, selectedBoxes),
  selectedPressed: under(checkboxPressed, selectedBoxes),
  disabled: box(':disabled'),
  selectedDisabled: list(selectedDisabledBoxes),
}))}

  /* The two marks. Fluent mounts its glyph only while the box is selected, so
     the check is drawn on a pseudo-element that is always present and the
     indeterminate dash on a second one, which is what lets the check carry the
     motion below and the dash arrive without any. Fluent's own glyph is hidden
     rather than restyled: no rule can reach the path inside it.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L604-L609 */
  .fui-Checkbox__indicator.fui-Checkbox__indicator > svg {
    display: none;
  }

  /* WinUI holds the mark at the primary on-accent colour through the unchecked
     states too, which is what the box shows while a check retracts.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L65-L67 */
  .fui-Checkbox__indicator.fui-Checkbox__indicator {
    color: var(--winui-text-on-accent-fill-primary);
  }

  .fui-Checkbox__indicator.fui-Checkbox__indicator::before,
  .fui-Checkbox__indicator.fui-Checkbox__indicator::after {
    content: '';
    background-color: currentColor;
    mask-repeat: no-repeat;
    mask-size: 100% 100%;
  }

  /* The check draws on left to right. WinUI trims the path by arc length, and
     this mark's two arms are close enough to equal slopes that the share of its
     width each arm spans matches its share of the length to within a fifth of a
     percent, so a wipe across the box tracks the trim.
     A departure on the way out: one interpolated property cannot also erase from
     the other end, so the retraction runs tip first where WinUI retracts from
     the tail. It was preferred to a keyframe pair, which would play the erase on
     every unchecked box at first paint.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/AnimatedIcon/AnimatedVisuals/AnimatedAcceptVisualSource.cpp#L534-L552 */
  .fui-Checkbox__indicator.fui-Checkbox__indicator::before {
    width: ${check.width};
    height: ${check.height};
    clip-path: inset(0 100% 0 0);
    mask-image: ${check.image};
    transform: translateY(${checkOffset});
    transition-duration: ${CHECK_OFF_MS};
    transition-property: clip-path;
    transition-timing-function: ${CHECK_OFF_EASING};
  }

  .fui-Checkbox__input:checked ~ .fui-Checkbox__indicator.fui-Checkbox__indicator::before {
    clip-path: inset(0 0 0 0);
    transition-duration: ${CHECK_ON_MS};
    transition-timing-function: ${CHECK_ON_EASING};
  }

  @supports (transition-timing-function: linear(0, 1)) {
    .fui-Checkbox__input:checked ~ .fui-Checkbox__indicator.fui-Checkbox__indicator::before {
      transition-timing-function: ${CHECK_ON_LINEAR_EASING};
    }
  }

  /* The indeterminate states name single frames rather than a transition pair,
     so AnimatedIcon cuts into and out of them. Swapping which mark is generated
     is that cut: a box that was not rendered has no earlier value to run from.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/AnimatedIcon/AnimatedVisuals/AnimatedAcceptVisualSource.cpp#L1981-L1983
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/AnimatedIcon/AnimatedIcon.cpp#L356-L362 */
  .fui-Checkbox__indicator.fui-Checkbox__indicator::after {
    display: none;
    width: ${dash.width};
    height: ${dash.height};
    mask-image: ${dash.image};
  }

  .fui-Checkbox__input${checkboxMixed} ~ .fui-Checkbox__indicator.fui-Checkbox__indicator::before {
    display: none;
  }

  .fui-Checkbox__input${checkboxMixed} ~ .fui-Checkbox__indicator.fui-Checkbox__indicator::after {
    display: block;
  }

  /* AnimatedIcon cuts to the destination frame when animations are off, so the
     preference lands on the same path the framework already takes.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/AnimatedIcon/AnimatedIcon.cpp#L435-L444 */
${nested(reducedMotion([
  '.fui-Checkbox__indicator.fui-Checkbox__indicator::before',
  '.fui-Checkbox__input:checked ~ .fui-Checkbox__indicator.fui-Checkbox__indicator::before',
], 'transition-duration'))}

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
    box-shadow: inset 0 0 0 var(--winui-focus-visual-secondary-thickness) var(--winui-focus-stroke-inner);
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

   https://www.w3.org/TR/WCAG21/#dfn-motion-animation
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L255-L259
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/components/vsm/VisualStateManagerActuator.cpp#L590-L609 */
${reducedMotion(['.fui-Radio__indicator.fui-Radio__indicator::after'], 'transition-duration')}

/* The same hit target as the check box above, on the ellipse. It is stated as a
   floor rather than a width because labelPosition="below" stacks the label under
   the ellipse and stretches the input to the full root width; a floor leaves
   that stretch intact. */
.fui-Radio__input.fui-Radio__input {
  min-width: calc(20px + 2 * var(--spacingHorizontalS));
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
     TextFillColorDisabled. Fluent walks its own neutral ramp for an unchecked
     radio under the pointer from a selector that ties this one on specificity
     and is inserted later, so the label slot is named a third time to clear it.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L122-L125
     https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-radio/library/src/components/Radio/useRadioStyles.styles.ts#L53-L67 */
  .fui-Radio .fui-Radio__input:enabled ~ .fui-Radio__label.fui-Radio__label.fui-Radio__label {
    color: var(--winui-text-fill-primary);
  }

  /* Unselected ellipse; WinUI washes the interior down the alt-fill ramp per
     state where Fluent leaves it transparent.

     The radio rules name the root where the check box rules do not, because
     Fluent reaches the two indicators differently: the check box's arrives
     through custom properties set by single-class atoms, so a rule on the
     indicator wins outright, while the radio's is styled from the input by
     selectors that carry up to four pseudo-classes. A rest rule has to outweigh
     the pointer ones, or Fluent takes the stroke back the moment the pointer
     lands, and the root is the class that gets it there.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L134-L135
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L138
     https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-radio/library/src/components/Radio/useRadioStyles.styles.ts#L50-L78 */
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
    box-shadow: inset 0 0 0 var(--winui-focus-visual-secondary-thickness) var(--winui-focus-stroke-inner);
  }
}
`;
