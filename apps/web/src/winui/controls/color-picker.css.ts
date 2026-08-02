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
  /* The slider thumbs are WinUI's colour-picker slider thumb: an
     elevation-stroked disc filled with the opaque outer-thumb background and
     carrying a 10px inner dot, held through every WinUI state. The disc never
     samples the picked colour, which Fluent fills it with, so it stays legible
     over the hue and alpha gradients it rides.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ColorPicker/ColorPicker.xaml#L435-L444
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Slider_themeresources.xaml#L18-L19
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ColorPicker/ColorPicker_themeresources.xaml#L5 */
  .fui-ColorSlider__thumb.fui-ColorSlider__thumb {
    --winui-color-picker-inner-thumb-size: calc(var(--fui-Slider__thumb--size) * 10 / 18);

    background-color: var(--winui-control-solid-fill-default);
    border-color: var(--winui-control-elevation-border-color);
    box-shadow: none;
  }

  /* ColorSpectrum's selection ellipse is a single stroke over the spectrum: the
     elevation border above belongs to the slider thumb, a different part, and
     the ring beneath is drawn by the rest ::before below.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ColorPicker/ColorSpectrum.xaml#L67-L69 */
  .fui-ColorArea__thumb.fui-ColorArea__thumb {
    border-color: transparent;
    box-shadow: none;
  }

  /* ColorSpectrum strokes its selection ellipse with SystemChromeWhiteColor,
     the same #FFFFFF in the Default, Light and HighContrast dictionaries alike,
     so it reads against any picked colour. Fluent draws it from
     colorNeutralBackground1, which this layer points at a surface fill, so in
     dark it came out a grey where WinUI is deliberately theme-invariant. WinUI
     additionally flips the ring to ChromeBlackHigh once the picked colour is
     light, which CSS cannot read.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ColorPicker/ColorSpectrum.xaml#L69
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/themes/generic.xaml#L223 */
  .fui-ColorArea__thumb.fui-ColorArea__thumb::before {
    border-color: #ffffff;
  }

  /* The slider thumb's inner dot. Fluent gives the thumb one full-bleed ring, so
     the dot is drawn as the ring's content box: the ring keeps the outer disc's
     fill and the remaining centre takes ColorPickerSliderThumbBackground. The
     dot holds ColorPickerSliderInnerThumbWidth as a share of
     SliderHorizontalThumbWidth, so it stays in proportion to whatever size
     Fluent lays the thumb out at.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ColorPicker/ColorPicker.xaml#L442
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ColorPicker/ColorPicker_themeresources.xaml#L33
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Slider_themeresources.xaml#L169 */
  .fui-ColorSlider__thumb.fui-ColorSlider__thumb::before {
    background-color: var(--winui-text-fill-primary);
    border-color: var(--winui-control-solid-fill-default);
    border-width: calc(
      (var(--fui-Slider__thumb--size) - var(--winui-color-picker-inner-thumb-size)) / 2
    );
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

  /* An unselected swatch under the pointer. WinUI keeps the accent ramp for
     selection and gives a merely-hovered tile the neutral on-accent stroke, so
     Fluent's accent double ring is replaced by the swatch's own 1px edge in
     that brush -- which Fluent also has to be given back, because it zeroes the
     border with the shorthand under the pointer and takes the width and the
     style with it. Pressed is a superset of pointer-over in WinUI: it moves the
     fill, not the stroke. Hovering is the weakest of the four states Fluent
     paints on this element, so selected, disabled and focus-visible each keep
     the ring they draw for themselves.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/GridViewItem_themeresources.xaml#L26-L29
     https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-swatch-picker/library/src/components/ColorSwatch/useColorSwatchStyles.styles.ts#L29-L36 */
  .fui-ColorSwatch.fui-ColorSwatch:not(
      [disabled],
      [aria-checked='true'],
      [aria-selected='true'],
      [data-fui-focus-visible]
    ):hover {
    border-width: 1px;
    border-style: solid;
    border-color: var(--winui-control-stroke-on-accent-tertiary);
    box-shadow: none;
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

  /* WinUI states Disabled in this family by swapping brushes only: it stamps no
     glyph over the content and draws no foreground drop-shadow, so Fluent's
     white ProhibitedFilled is dropped and the chip is washed instead with
     AccentFillColorDisabled, the fill a disabled colour-filled WinUI surface
     takes -- an accent Button is the same case. The wash is layered over the
     colour the caller passed rather than replacing it, so the swatch still
     names its colour while it reads as inert. Both rules are colour-scoped
     together: in forced colours the wash would be a literal the system palette
     never reaches, and the glyph is then the only disabled cue left.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L38
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L242
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L8
     https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-swatch-picker/library/src/components/ColorSwatch/useColorSwatchStyles.styles.ts#L154-L156 */
  .fui-ColorSwatch.fui-ColorSwatch[disabled] {
    background-image: linear-gradient(
      var(--winui-accent-fill-disabled),
      var(--winui-accent-fill-disabled)
    );
  }

  /* The glyph is addressed by position because Fluent declares a class name for
     the slot and then never merges it in, so the span carries only Griffel
     hashes. It is rendered last, after the caller's own icon slot when there is
     one.
     https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-swatch-picker/library/src/components/ColorSwatch/useColorSwatchStyles.styles.ts#L202-L210
     https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-swatch-picker/library/src/components/ColorSwatch/renderColorSwatch.tsx#L16-L18 */
  .fui-ColorSwatch[disabled] > span:last-child {
    display: none;
  }

  /* An empty swatch is a placeholder awaiting a value, which WinUI outlines
     with the strong stroke it gives an unfilled control body -- a cleared
     CheckBox is the same case -- rather than the faint stroke of a filled one.
     The stroke is solid: XAML Border has no dash concept, so no shipping WinUI
     control template can draw the dashed edge Fluent gives this swatch.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L41
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L48 */
  .fui-EmptySwatch.fui-EmptySwatch {
    border-style: solid;
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
