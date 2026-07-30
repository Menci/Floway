// Colour picker restyled against WinUI 3's Slider, the one control in the
// corpus that shares parts with it. WinUI ships no ColorPicker, so the mapping
// is deliberately narrow: the area's gradient field, the hue rail's spectrum,
// both thumb fills and the swatch body are the picked colour, which no theme
// resource may repaint. Only the chrome drawn around those surfaces — the
// outline of the field, the ring of the thumb, the stroke of a swatch, and the
// focus visual — takes WinUI's paint.
//
// Left to Fluent, each for a reason recorded here rather than in a rule:
//
// The thumb's inner white ring keeps `colorNeutralBackground1`. WinUI paints
// the outer thumb with ControlSolidFillColorDefault, which the vocabulary does
// not carry.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Slider_themeresources.xaml#L19
//
// The hue rail keeps its radius. SliderTrackCornerRadius is 2 against a 4px
// track, a pill; the colour rail is 20px tall, where the same 2px reads as a
// squared band instead.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Slider_themeresources.xaml#L162
//
// The slider's pointer states keep Fluent's paint. WinUI walks the thumb fill
// down the accent ramp and scales its 12px inner ellipse on pointer-over and
// pressed, but here that interior is the picked colour, so neither has a
// subject; Fluent declares no such state either.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Slider_themeresources.xaml#L14-L16
//
// The swatch's hover, pressed and selected rings keep Fluent's brand strokes.
// The accent ramp maps onto them, but the spreads are size-dependent and the
// size variants carry no public class: `small` redeclares the pressed ring and
// `extra-small` redeclares both, so one global rule keyed to the swatch class
// would freeze the medium geometry onto the smaller sizes.

export const colorPickerCss = `
/* Both thumbs are WinUI's slider thumb: an elevation-stroked ring with no
   shadow under it. The stroke is an absolute-mapped gradient, so it lands as
   the three-term border-color the vocabulary composes.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Slider_themeresources.xaml#L18
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Slider_themeresources.xaml#L198 */
.fui-ColorArea__thumb.fui-ColorArea__thumb,
.fui-ColorSlider__thumb.fui-ColorSlider__thumb {
  border-color: var(--winui-control-elevation-border-color);
  box-shadow: none;
}

/* Fluent draws exactly one ring for thumb focus — an ::after overlay on the
   area's thumb, the thumb border itself on the slider's — and that ring is the
   one WinUI keys to FocusStrokeColorOuter, so only its colour moves. The white
   ring under it is the thumb's rest-state ::before, not a second focus ring, so
   FocusStrokeColorInner has no subject on either thumb.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L258 */
.fui-ColorArea__thumb.fui-ColorArea__thumb[data-fui-focus-within]:focus-within::after,
.fui-ColorSlider__input:focus-visible ~ .fui-ColorSlider__thumb.fui-ColorSlider__thumb {
  border-color: var(--winui-focus-stroke-outer);
}

/* A swatch is a colour chip on a surface; WinUI never leaves such a body
   unstroked, so the transparent default border takes the control stroke. Image
   swatches build their rest border identically and are restated with them. The
   hover and selected states blank the border outright and are unaffected. A
   colour swatch always writes --fui-SwatchPicker--borderColor from its
   borderColor prop, so this rule also overrides a caller-supplied border; we
   accept that, because a per-chip border would step outside the vocabulary the
   rest of the picker is drawn in.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L243 */
.fui-ColorSwatch.fui-ColorSwatch,
.fui-ImageSwatch.fui-ImageSwatch {
  border-color: var(--winui-control-stroke-default);
}

/* An empty swatch is a placeholder awaiting a value, which WinUI outlines with
   the strong stroke it gives an unfilled control body rather than the faint
   stroke of a filled one. Fluent's dash is the emptiness affordance and stays.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L48 */
.fui-EmptySwatch.fui-EmptySwatch {
  border-color: var(--winui-control-strong-stroke-default);
}

/* The swatch's focus visual is the same outer/inner ring pair, painted as two
   inset shadows because the chip has no room for a ring outside its box. A
   shadow list cannot be overridden term by term, so the widths are repeated
   unchanged and only the two colours move to WinUI's focus strokes. Image
   swatches share the construction and the selected widths. The selected swatch
   widens both rings and is addressed through the ARIA state SwatchPicker
   writes: it renders each swatch as a gridcell carrying aria-selected when the
   picker is a grid, and as a radio carrying aria-checked when it is not. An
   empty swatch never selects and draws no focus ring of its own.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L258-L259 */
.fui-ColorSwatch.fui-ColorSwatch[data-fui-focus-visible],
.fui-ImageSwatch.fui-ImageSwatch[data-fui-focus-visible] {
  box-shadow:
    inset 0 0 0 var(--strokeWidthThick) var(--winui-focus-stroke-outer),
    inset 0 0 0 var(--strokeWidthThicker) var(--winui-focus-stroke-inner);
}

.fui-ColorSwatch.fui-ColorSwatch[aria-checked="true"][data-fui-focus-visible],
.fui-ColorSwatch.fui-ColorSwatch[aria-selected="true"][data-fui-focus-visible],
.fui-ImageSwatch.fui-ImageSwatch[aria-checked="true"][data-fui-focus-visible],
.fui-ImageSwatch.fui-ImageSwatch[aria-selected="true"][data-fui-focus-visible] {
  box-shadow:
    inset 0 0 0 var(--strokeWidthThicker) var(--winui-focus-stroke-outer),
    inset 0 0 0 5px var(--winui-focus-stroke-inner);
}
`;
