// AlphaSlider composes ColorSlider's own styles, so every ColorSlider rule
// below reaches it; only its extra rail border is addressed on the alpha name.
//
// The field's outline needs no rule of its own: Fluent draws it with
// colorNeutralStroke1, which theme.ts already points at
// --winui-control-stroke-default, the value ColorPickerBorderBrush resolves to.
//
// Colour is confined to `@media not (forced-colors: active)`. Fluent has
// already put `forced-color-adjust: none` on the area, the rails, the thumbs
// and a filled swatch, so a value written there is a literal the system palette
// never reaches. Geometry applies in both modes.

export const colorPickerCss = `
/* ColorPickerSliderCornerRadius, which WinUI states for this control's own
   track rather than the 2px of a plain Slider.
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

  /* WinUI leaves both slider gradients unstroked; Fluent's neutral border on
     the alpha rail is painted out rather than removed, so the rail keeps the
     box it lays out with.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ColorPicker/ColorPicker.xaml#L239
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ColorPicker/ColorPicker.xaml#L252 */
  .fui-AlphaSlider__rail.fui-AlphaSlider__rail {
    border-color: transparent;
  }

  /* WinUI trades ColorSpectrum's outer focus stroke for the inner one once the
     picked colour is light; a CSS rule cannot read that colour, so the ring
     takes FocusStrokeColorOuter, keyed to the theme instead.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ColorPicker/ColorSpectrum.xaml#L68-L69
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L258 */
  .fui-ColorArea__thumb.fui-ColorArea__thumb[data-fui-focus-within]:focus-within::after {
    border-color: var(--winui-focus-stroke-outer);
  }

  /* Only the outer stroke's colour transcribes. FocusStrokeColorInner does not:
     the white ring beneath is the thumb's rest ::before, not a second focus
     ring.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L258 */
  .fui-ColorSlider__input:focus-visible ~ .fui-ColorSlider__thumb.fui-ColorSlider__thumb {
    border-color: var(--winui-focus-stroke-outer);
  }

  /* The brush WinUI strokes its colour preview with. A colour swatch always
     writes --fui-SwatchPicker--borderColor from its borderColor prop, so this
     rule makes that prop inert.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ColorPicker/ColorPicker_themeresources.xaml#L11
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L243 */
  .fui-ColorSwatch.fui-ColorSwatch {
    border-color: var(--winui-control-stroke-default);
  }

  /* An empty swatch is a placeholder awaiting a value, which WinUI outlines
     with the strong stroke it gives an unfilled control body -- a cleared
     CheckBox is the same case -- rather than the faint stroke of a filled one.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L41
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L48 */
  .fui-EmptySwatch.fui-EmptySwatch {
    border-color: var(--winui-control-strong-stroke-default);
  }

  /* box-shadow is atomic, so the whole list is restated to move the two
     colours; the widths come back unchanged because Fluent's pairs already
     render WinUI's ring visuals. The selected swatch is addressed through the
     ARIA state SwatchPicker writes, which is aria-selected on a grid and
     aria-checked otherwise.
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
