// Colour picker restyled against WinUI 3's ColorPicker and the two primitives
// its template instantiates, ColorSpectrum and ColorPickerSlider. Fluent's
// ColorArea, ColorSlider, AlphaSlider and SwatchPicker do not line up part for
// part with those templates, so the mapping is narrow by choice: the area's
// gradient field, both rails' gradients, all three thumb fills and the swatch
// body are the picked colour, which no theme resource may repaint. What takes
// WinUI's paint is the chrome around those surfaces -- the ring of a thumb,
// the radius and stroke of a rail, the stroke of a swatch and the focus
// visual. AlphaSlider composes ColorSlider's own styles, so its rail, thumb
// and input carry both class names and every ColorSlider rule below reaches
// it; only its extra rail border is addressed on the alpha name.
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
// Colour is confined to `@media not (forced-colors: active)`. WinUI answers
// Windows High Contrast with dictionaries of its own -- ColorPickerBorderBrush
// becomes SystemControlForegroundListLow, the focus stroke becomes
// SystemColorWindowText over SystemColorWindow -- but Fluent has already put
// `forced-color-adjust: none` on the area, the rails, the thumbs and a filled
// swatch, so a value written there is a literal the system palette never
// reaches. Forced colours therefore keeps Fluent's drawing, which puts
// Highlight on the area thumb's focus ring and leaves a swatch on its brand
// strokes; only the empty swatch, which carries no such opt-out, is repainted
// by the system. Geometry applies in both modes.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ColorPicker/ColorPicker_themeresources.xaml#L22-L29
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L472-L473
//
// Left to Fluent, each for a reason recorded here rather than in a rule:
//
// The slider thumb's ring, between its border and its core, keeps
// `colorNeutralBackground1`. WinUI fills it with SliderOuterThumbBackground,
// which resolves to ControlSolidFillColorDefault; our --winui-* vocabulary
// does not carry that colour, and we do not spend a raw literal at a control
// rule to introduce one.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ColorPicker/ColorPicker.xaml#L441
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Slider_themeresources.xaml#L19
//
// The area thumb's ring keeps it too. Its WinUI counterpart is ColorSpectrum's
// SelectionEllipse, stroked ChromeWhite and traded for ChromeBlackHigh once
// the picked colour is light enough to swallow a white ring. A CSS rule cannot
// read the colour under the thumb, so the theme-keyed neutral stands.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ColorPicker/ColorSpectrum.xaml#L28-L32
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ColorPicker/ColorSpectrum.xaml#L69
//
// The pointer states keep Fluent's paint on both primitives. WinUI moves one
// brush on the slider's pointer-over, the fill of the thumb's inner ellipse --
// its pressed value is the rest value again -- and on the area it dims the
// selection ellipse and grows the thumb to 48px under a pen. Here the thumb's
// interior is the picked colour, so the fill swap has no subject, and the
// stateless thumb Fluent declares stands.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ColorPicker/ColorPicker_themeresources.xaml#L4-L6
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ColorPicker/ColorPicker.xaml#L469-L473
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ColorPicker/ColorSpectrum.xaml#L13-L24
//
// The disabled dictionary has no subject at all. Fluent's ColorArea and
// ColorSlider expose no disabled prop, so WinUI's washed thumb over a washed
// track reaches no DOM here.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ColorPicker/ColorPicker.xaml#L461-L468
//
// The swatch's hover, pressed and selected rings keep Fluent's brand strokes,
// and a disabled swatch keeps its inverted-foreground slash. WinUI's
// ColorPicker offers no palette to pick from, so none of those states has a
// WinUI counterpart to transcribe.

export const colorPickerCss = `
/* The rail takes ColorPickerSliderCornerRadius, the radius WinUI states for
   this control's own track rather than the 2px of a plain Slider. Its height
   stays Fluent's 20px, where WinUI's rail is 12: the rail here carries the
   whole spectrum and we want it read as a band.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ColorPicker/ColorPicker_themeresources.xaml#L32 */
.fui-ColorSlider__rail.fui-ColorSlider__rail {
  border-radius: 6px;
}

@media not (forced-colors: active) {
  /* Both thumbs are WinUI's colour-picker slider thumb: an elevation-stroked
     ring with no shadow under it. The stroke is an absolute-mapped gradient,
     so it lands as the three-term border-color the vocabulary composes, and it
     holds through every WinUI state.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ColorPicker/ColorPicker.xaml#L441
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Slider_themeresources.xaml#L18 */
  .fui-ColorArea__thumb.fui-ColorArea__thumb,
  .fui-ColorSlider__thumb.fui-ColorSlider__thumb {
    border-color: var(--winui-control-elevation-border-color);
    box-shadow: none;
  }

  /* WinUI leaves both slider gradients unstroked -- the hue rectangle and the
     alpha rectangle over its checkerboard carry a fill and a corner radius and
     no Stroke -- and gives an outline only to the colour preview. Fluent
     agrees on the hue rail, whose outline is transparent, and puts a neutral
     border on the alpha rail; that border is painted out rather than removed,
     so the rail keeps the box it lays out with.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ColorPicker/ColorPicker.xaml#L239
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ColorPicker/ColorPicker.xaml#L252 */
  .fui-AlphaSlider__rail.fui-AlphaSlider__rail {
    border-color: transparent;
  }

  /* The area's focus ring is ColorSpectrum's FocusEllipse: a 2px ellipse shown
     on focus outside the 2px SelectionEllipse the thumb wears at rest, which
     is the pair Fluent builds from the thumb's ::before and its focus ::after.
     WinUI strokes the outer one ChromeBlackHigh and trades it with the inner
     ring once the picked colour is light. A CSS rule cannot read that colour,
     so the ring takes FocusStrokeColorOuter: the same near-black over white,
     keyed to the theme rather than to what sits under the thumb.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ColorPicker/ColorSpectrum.xaml#L68-L69
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L258 */
  .fui-ColorArea__thumb.fui-ColorArea__thumb[data-fui-focus-within]:focus-within::after {
    border-color: var(--winui-focus-stroke-outer);
  }

  /* The slider's focus visual is the system one, which WinUI draws around the
     whole SliderContainer; Fluent has only the thumb to draw on and turns its
     border into the ring. The outer stroke's colour transcribes onto that
     ring. Its placement does not, and neither does FocusStrokeColorInner: the
     white ring beneath is the thumb's rest ::before, not a second focus ring.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ColorPicker/ColorPicker.xaml#L492
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L258 */
  .fui-ColorSlider__input:focus-visible ~ .fui-ColorSlider__thumb.fui-ColorSlider__thumb {
    border-color: var(--winui-focus-stroke-outer);
  }

  /* A swatch is a colour chip on a surface, which is what WinUI's colour
     preview is, and WinUI strokes that preview with ColorPickerBorderBrush;
     the swatch's transparent default border takes the same value. Image
     swatches build their rest border identically and are restated with them.
     The hover, pressed and selected states blank the border outright and are
     unaffected; a disabled swatch holds the rest border, as a disabled WinUI
     control body holds ControlStrokeColorDefault. A colour swatch always
     writes --fui-SwatchPicker--borderColor from its borderColor prop, so this
     rule makes that prop inert; we accept that, because a per-chip border
     would step outside the vocabulary the rest of the picker is drawn in.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ColorPicker/ColorPicker_themeresources.xaml#L11
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L243 */
  .fui-ColorSwatch.fui-ColorSwatch,
  .fui-ImageSwatch.fui-ImageSwatch {
    border-color: var(--winui-control-stroke-default);
  }

  /* An empty swatch is a placeholder awaiting a value, which WinUI outlines
     with the strong stroke it gives an unfilled control body -- a cleared
     CheckBox is the same case -- rather than the faint stroke of a filled one.
     Fluent's dash is the emptiness affordance and stays.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L41
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L48 */
  .fui-EmptySwatch.fui-EmptySwatch {
    border-color: var(--winui-control-strong-stroke-default);
  }

  /* The swatch's focus visual is the same outer/inner ring pair, painted as
     two inset shadows. box-shadow is atomic, so the whole list is restated to
     move the two colours; the widths come back unchanged because Fluent's
     unselected pair already renders WinUI's focus visual -- 2px of outer
     stroke over 1px of inner. WinUI states both placements for a collection
     item, inset by 1 for a ListViewItem and pushed out by 3 for a
     GridViewItem, so the inset construction Fluent chose is left alone. Image
     swatches share the construction and the selected widths. The selected
     swatch widens both rings to 3px over 2px, wider than WinUI's visual, and
     stays there because WinUI has no selected-swatch state to measure it
     against; it is addressed through the ARIA state SwatchPicker writes,
     rendering each swatch as a gridcell carrying aria-selected when the picker
     is a grid and as a radio carrying aria-checked when it is not. An empty
     swatch never selects and draws no focus ring of its own.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L248-L252
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/GridViewItem_themeresources.xaml#L149-L153
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L258-L259 */
  .fui-ColorSwatch.fui-ColorSwatch[data-fui-focus-visible],
  .fui-ImageSwatch.fui-ImageSwatch[data-fui-focus-visible] {
    box-shadow:
      inset 0 0 0 var(--strokeWidthThick) var(--winui-focus-stroke-outer),
      inset 0 0 0 var(--strokeWidthThicker) var(--winui-focus-stroke-inner);
  }

  .fui-ColorSwatch.fui-ColorSwatch[aria-checked='true'][data-fui-focus-visible],
  .fui-ColorSwatch.fui-ColorSwatch[aria-selected='true'][data-fui-focus-visible],
  .fui-ImageSwatch.fui-ImageSwatch[aria-checked='true'][data-fui-focus-visible],
  .fui-ImageSwatch.fui-ImageSwatch[aria-selected='true'][data-fui-focus-visible] {
    box-shadow:
      inset 0 0 0 var(--strokeWidthThicker) var(--winui-focus-stroke-outer),
      inset 0 0 0 5px var(--winui-focus-stroke-inner);
  }
}
`;
