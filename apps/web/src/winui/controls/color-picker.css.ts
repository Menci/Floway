// Colour picker restyled against WinUI 3's ColorPicker and the two primitives
// its template instantiates, ColorSpectrum and ColorPickerSlider. Fluent's
// ColorArea, ColorSlider, AlphaSlider and SwatchPicker do not line up part for
// part with those templates, so the mapping is narrow by choice: every surface
// that shows the picked colour is left alone, and only the chrome around them
// takes WinUI's paint. AlphaSlider composes ColorSlider's own styles, so every
// ColorSlider rule below reaches it; only its extra rail border is addressed on
// the alpha name.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ColorPicker/ColorPicker.xaml#L213-L255
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ColorPicker/ColorPicker.xaml#L428-L446
//
// The field's outline needs no rule of its own. Fluent draws it with
// colorNeutralStroke1, which theme.ts already points at
// --winui-control-stroke-default -- the value ColorPickerBorderBrush resolves
// to, the brush ColorSpectrum strokes its own rectangle with.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ColorPicker/ColorPicker_themeresources.xaml#L11
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ColorPicker/ColorPicker_themeresources.xaml#L40-L43
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ColorPicker/ColorSpectrum.xaml#L76
//
// Colour is confined to `@media not (forced-colors: active)`. Fluent has
// already put `forced-color-adjust: none` on the area, the rails, the thumbs
// and a filled swatch, so a value written there is a literal the system palette
// never reaches. Geometry applies in both modes.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ColorPicker/ColorPicker_themeresources.xaml#L22-L29
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L472-L473
//
// Left to Fluent, each for a reason recorded here rather than in a rule:
//
// The slider thumb's ring keeps `colorNeutralBackground1`. WinUI fills it with
// ControlSolidFillColorDefault, which the --winui-* vocabulary does not carry,
// and a raw literal is not spent at a control rule to introduce one.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ColorPicker/ColorPicker.xaml#L441
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Slider_themeresources.xaml#L19
//
// The area thumb's ring keeps it too: WinUI trades its stroke for a dark one
// once the picked colour is light enough to swallow a white ring, and a CSS
// rule cannot read the colour under the thumb.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ColorPicker/ColorSpectrum.xaml#L28-L32
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ColorPicker/ColorSpectrum.xaml#L69
//
// The pointer states keep Fluent's paint on both primitives: the one brush
// WinUI moves is the fill of the thumb's inner ellipse, which here is the
// picked colour, so the swap has no subject.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ColorPicker/ColorPicker_themeresources.xaml#L4-L6
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ColorPicker/ColorPicker.xaml#L469-L473
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ColorPicker/ColorSpectrum.xaml#L13-L24
//
// The disabled dictionary has no subject at all: Fluent's ColorArea and
// ColorSlider expose no disabled prop.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ColorPicker/ColorPicker.xaml#L461-L468
//
// The swatch's hover, pressed and selected rings keep Fluent's brand strokes,
// and a disabled swatch keeps its inverted-foreground slash: WinUI's
// ColorPicker offers no palette, so none of those states has a counterpart.

export const colorPickerCss = `
/* The rail takes ColorPickerSliderCornerRadius, the radius WinUI states for
   this control's own track rather than the 2px of a plain Slider. Its height
   stays Fluent's 20px, where WinUI's rail is 12, so the rail reads as a band.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ColorPicker/ColorPicker_themeresources.xaml#L32 */
.fui-ColorSlider__rail.fui-ColorSlider__rail {
  border-radius: 6px;
}

@media not (forced-colors: active) {
  /* Both thumbs are WinUI's colour-picker slider thumb: an elevation-stroked
     ring with no shadow under it, held through every WinUI state.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ColorPicker/ColorPicker.xaml#L441
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Slider_themeresources.xaml#L18 */
  .fui-ColorArea__thumb.fui-ColorArea__thumb,
  .fui-ColorSlider__thumb.fui-ColorSlider__thumb {
    border-color: var(--winui-control-elevation-border-color);
    box-shadow: none;
  }

  /* WinUI leaves both slider gradients unstroked and gives an outline only to
     the colour preview. Fluent puts a neutral border on the alpha rail; it is
     painted out rather than removed, so the rail keeps the box it lays out
     with.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ColorPicker/ColorPicker.xaml#L239
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ColorPicker/ColorPicker.xaml#L252 */
  .fui-AlphaSlider__rail.fui-AlphaSlider__rail {
    border-color: transparent;
  }

  /* The area's focus ring is ColorSpectrum's FocusEllipse, outside the
     SelectionEllipse the thumb wears at rest -- the pair Fluent builds from the
     thumb's ::before and its focus ::after. WinUI trades the outer stroke with
     the inner one once the picked colour is light; a CSS rule cannot read that
     colour, so the ring takes FocusStrokeColorOuter, keyed to the theme rather
     than to what sits under the thumb.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ColorPicker/ColorSpectrum.xaml#L68-L69
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L258 */
  .fui-ColorArea__thumb.fui-ColorArea__thumb[data-fui-focus-within]:focus-within::after {
    border-color: var(--winui-focus-stroke-outer);
  }

  /* The slider's focus visual is the system one, which WinUI draws around the
     whole SliderContainer; Fluent has only the thumb to draw on and turns its
     border into the ring, so only the outer stroke's colour transcribes.
     FocusStrokeColorInner does not: the white ring beneath is the thumb's rest
     ::before, not a second focus ring.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ColorPicker/ColorPicker.xaml#L492
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L258 */
  .fui-ColorSlider__input:focus-visible ~ .fui-ColorSlider__thumb.fui-ColorSlider__thumb {
    border-color: var(--winui-focus-stroke-outer);
  }

  /* A swatch is a colour chip on a surface, which is what WinUI's colour
     preview is, so the swatch's transparent default border takes the brush
     WinUI strokes that preview with. A colour swatch always writes
     --fui-SwatchPicker--borderColor from its borderColor prop, so this rule
     makes that prop inert; a per-chip border would step outside the vocabulary
     the rest of the picker is drawn in.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ColorPicker/ColorPicker_themeresources.xaml#L11
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L243 */
  .fui-ColorSwatch.fui-ColorSwatch {
    border-color: var(--winui-control-stroke-default);
  }

  /* An empty swatch is a placeholder awaiting a value, which WinUI outlines
     with the strong stroke it gives an unfilled control body -- a cleared
     CheckBox is the same case -- rather than the faint stroke of a filled
     one.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L41
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L48 */
  .fui-EmptySwatch.fui-EmptySwatch {
    border-color: var(--winui-control-strong-stroke-default);
  }

  /* The swatch's focus visual is the same outer/inner ring pair, painted as two
     inset shadows. box-shadow is atomic, so the whole list is restated to move
     the two colours; the widths come back unchanged because Fluent's unselected
     pair already renders WinUI's 2px-over-1px visual. WinUI states both
     placements for a collection item, so the inset construction Fluent chose is
     left alone. The selected swatch keeps Fluent's wider 3px-over-2px rings,
     because WinUI has no selected-swatch state to measure them against; it is
     addressed through the ARIA state SwatchPicker writes, which is
     aria-selected on a grid and aria-checked otherwise.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L248-L252
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/GridViewItem_themeresources.xaml#L149-L153
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L258-L259 */
  .fui-ColorSwatch.fui-ColorSwatch[data-fui-focus-visible] {
    box-shadow:
      inset 0 0 0 var(--strokeWidthThick) var(--winui-focus-stroke-outer),
      inset 0 0 0 var(--strokeWidthThicker) var(--winui-focus-stroke-inner);
  }

  .fui-ColorSwatch.fui-ColorSwatch[aria-checked='true'][data-fui-focus-visible],
  .fui-ColorSwatch.fui-ColorSwatch[aria-selected='true'][data-fui-focus-visible] {
    box-shadow:
      inset 0 0 0 var(--strokeWidthThicker) var(--winui-focus-stroke-outer),
      inset 0 0 0 calc(var(--strokeWidthThicker) + var(--strokeWidthThick)) var(--winui-focus-stroke-inner);
  }
}
`;
