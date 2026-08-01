// Colour picker restyled against WinUI 3's ColorPicker and the
// ColorPickerSlider primitive its template instantiates. Fluent's ColorArea,
// ColorSlider and SwatchPicker do not line up part for part with that
// template, so the mapping is narrow by choice: the area's gradient field, the
// hue rail's spectrum, both thumb fills and the swatch body are the picked
// colour, which no theme resource may repaint. What takes WinUI's paint is the
// chrome around those surfaces -- the ring of the thumb, the radius of the
// rail, the stroke of a swatch and the focus visual.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ColorPicker/ColorPicker.xaml#L428-L446
//
// The field's outline needs no rule of its own. Fluent draws it with
// colorNeutralStroke1, which theme.ts already points at
// --winui-control-stroke-default -- the value ColorPickerBorderBrush resolves
// to, the brush WinUI strokes its own colour surface with.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ColorPicker/ColorPicker_themeresources.xaml#L11
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ColorPicker/ColorPicker_themeresources.xaml#L40-L43
//
// Left to Fluent, each for a reason recorded here rather than in a rule:
//
// The ring between the thumb's border and its core keeps
// `colorNeutralBackground1`. WinUI fills it with SliderOuterThumbBackground,
// which resolves to ControlSolidFillColorDefault; our --winui-* vocabulary
// does not carry that colour, and we do not spend a raw literal at a control
// rule to introduce one.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ColorPicker/ColorPicker.xaml#L441
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Slider_themeresources.xaml#L19
//
// The slider's pointer states keep Fluent's paint. WinUI moves one brush on
// pointer-over and on pressed, the fill of the thumb's inner ellipse; here
// that interior is the picked colour, so the swap has no subject and the
// stateless thumb Fluent declares stands.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ColorPicker/ColorPicker.xaml#L456-L460
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ColorPicker/ColorPicker.xaml#L469-L473
//
// The swatch's hover, pressed and selected rings keep Fluent's brand strokes.
// WinUI's ColorPicker offers no palette to pick from, so none of those three
// states has a WinUI counterpart to transcribe.

export const colorPickerCss = `
/* Both thumbs are WinUI's colour-picker slider thumb: an elevation-stroked
   ring with no shadow under it. The stroke is an absolute-mapped gradient, so
   it lands as the three-term border-color the vocabulary composes.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ColorPicker/ColorPicker.xaml#L441
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Slider_themeresources.xaml#L18 */
.fui-ColorArea__thumb.fui-ColorArea__thumb,
.fui-ColorSlider__thumb.fui-ColorSlider__thumb {
  border-color: var(--winui-control-elevation-border-color);
  box-shadow: none;
}

/* The rail takes ColorPickerSliderCornerRadius, the radius WinUI states for
   this control's own track rather than the 2px of a plain Slider. Its height
   stays Fluent's 20px, where WinUI's rail is 12: the rail here carries the
   whole spectrum and we want it read as a band.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ColorPicker/ColorPicker_themeresources.xaml#L32 */
.fui-ColorSlider__rail.fui-ColorSlider__rail {
  border-radius: 6px;
}

/* Fluent draws exactly one ring for thumb focus -- an ::after overlay on the
   area's thumb, the thumb border itself on the slider's -- and that ring is the
   one WinUI keys to FocusStrokeColorOuter, so only its colour moves. The white
   ring under it is the thumb's rest-state ::before, not a second focus ring, so
   FocusStrokeColorInner has no subject on either thumb.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L258 */
.fui-ColorArea__thumb.fui-ColorArea__thumb[data-fui-focus-within]:focus-within::after,
.fui-ColorSlider__input:focus-visible ~ .fui-ColorSlider__thumb.fui-ColorSlider__thumb {
  border-color: var(--winui-focus-stroke-outer);
}

/* A swatch is a colour chip on a surface, which is what WinUI's colour preview
   is, and WinUI strokes that preview with ColorPickerBorderBrush; the swatch's
   transparent default border takes the same value. Image swatches build their
   rest border identically and are restated with them. The hover and selected
   states blank the border outright and are unaffected. A colour swatch always
   writes --fui-SwatchPicker--borderColor from its borderColor prop, so this
   rule makes that prop inert; we accept that, because a per-chip border would
   step outside the vocabulary the rest of the picker is drawn in.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ColorPicker/ColorPicker_themeresources.xaml#L11
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L243 */
.fui-ColorSwatch.fui-ColorSwatch,
.fui-ImageSwatch.fui-ImageSwatch {
  border-color: var(--winui-control-stroke-default);
}

/* An empty swatch is a placeholder awaiting a value, which WinUI outlines with
   the strong stroke it gives an unfilled control body -- a cleared CheckBox is
   the same case -- rather than the faint stroke of a filled one. Fluent's dash
   is the emptiness affordance and stays.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L41
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L48 */
.fui-EmptySwatch.fui-EmptySwatch {
  border-color: var(--winui-control-strong-stroke-default);
}

/* The swatch's focus visual is the same outer/inner ring pair, painted as two
   inset shadows. box-shadow is atomic, so the whole list is restated to move
   the two colours; the widths come back unchanged because Fluent's unselected
   pair already renders WinUI's focus visual -- 2px of outer stroke over 1px of
   inner. WinUI states both placements for a collection item, inset by 1 for a
   ListViewItem and pushed out by 3 for a GridViewItem, so the inset
   construction Fluent chose is left alone. Image swatches share the
   construction and the selected widths. The selected swatch widens both rings
   to 3px over 2px, wider than WinUI's visual, and stays there because WinUI
   has no selected-swatch state to measure it against; it is addressed through
   the ARIA state SwatchPicker writes, rendering each swatch as a gridcell
   carrying aria-selected when the picker is a grid and as a radio carrying
   aria-checked when it is not. An empty swatch never selects and draws no
   focus ring of its own.
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
`;
