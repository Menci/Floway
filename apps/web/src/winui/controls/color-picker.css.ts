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

  /* The rings the three thumbs ride in. ColorSpectrum strokes its selection
     ellipse with SystemChromeWhiteColor, the same #FFFFFF in the Default, Light
     and HighContrast dictionaries alike, so it reads against any picked colour;
     the two slider thumbs back theirs with the ColorPicker's own
     SliderOuterThumbBackground. Fluent draws all three from
     colorNeutralBackground1, which this layer points at a surface fill, so in
     dark they came out one ramp step darker than WinUI and, on the spectrum, a
     grey where WinUI is deliberately theme-invariant. WinUI additionally flips
     the spectrum ring to ChromeBlackHigh once the picked colour is light, which
     CSS cannot read.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ColorPicker/ColorSpectrum.xaml#L73
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ColorPicker/ColorPicker.xaml#L441
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L24
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/themes/generic.xaml#L223 */
  .fui-ColorArea__thumb.fui-ColorArea__thumb::before {
    border-color: #ffffff;
  }

  .fui-ColorSlider__thumb.fui-ColorSlider__thumb::before,
  .fui-AlphaSlider__thumb.fui-AlphaSlider__thumb::before {
    border-color: var(--winui-control-solid-fill-default);
  }

  /* ColorSpectrum's one pointer state.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ColorPicker/ColorSpectrum.xaml#L17-L21 */
  .fui-ColorArea:hover .fui-ColorArea__thumb.fui-ColorArea__thumb {
    opacity: 0.8;
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

  /* Fluent zeroes the swatch border with the shorthand under the pointer, which
     takes the width and the style with it, so a colour alone does not survive
     those two states.
     https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-swatch-picker/library/src/components/ColorSwatch/useColorSwatchStyles.styles.ts#L29-L36 */
  .fui-ColorSwatch.fui-ColorSwatch:hover,
  .fui-ColorSwatch.fui-ColorSwatch:hover:active {
    border-width: 1px;
    border-style: solid;
  }

  /* A disabled control never leaves WinUI's Disabled state, and Fluent's own
     disabled variant clears only the hover ring: its pressed override resets
     the border and leaves the box-shadow standing, which Chrome still matches
     on a disabled button.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ColorPicker/ColorPicker.xaml#L455-L474 */
  .fui-ColorSwatch.fui-ColorSwatch[disabled]:hover,
  .fui-ColorSwatch.fui-ColorSwatch[disabled]:hover:active {
    box-shadow: none;
  }

  /* An empty swatch is a placeholder awaiting a value, which WinUI outlines
     with the strong stroke it gives an unfilled control body -- a cleared
     CheckBox is the same case -- rather than the faint stroke of a filled one.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L41
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L48 */
  .fui-EmptySwatch.fui-EmptySwatch {
    border-color: var(--winui-control-strong-stroke-default);
  }

  /* An empty swatch is built from its own reset, which includes none of the
     ColorSwatch base -- so it ships no focus indicator at all and fell through
     to the user agent's outline while every other swatch drew WinUI's two
     rings. The pair is stated here at the widths Fluent gives an unselected
     swatch.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L258-L259
     https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-swatch-picker/library/src/components/EmptySwatch/useEmptySwatchStyles.styles.ts#L10-L13 */
  .fui-EmptySwatch.fui-EmptySwatch[data-fui-focus-visible] {
    outline-style: none;
    box-shadow:
      inset 0 0 0 var(--strokeWidthThick) var(--winui-focus-stroke-outer),
      inset 0 0 0 var(--strokeWidthThicker) var(--winui-focus-stroke-inner);
  }
}
`;
