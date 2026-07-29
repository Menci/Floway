// The WinUI 3 color vocabulary, transcribed from the shipping theme resource
// dictionaries so later components can name a WinUI fill or stroke directly
// instead of approximating it with a Fluent v9 token. In WinUI the dictionary
// keyed "Default" is the dark theme and "Light" is the light one; here the
// unqualified block is light and the dark values live under
// `prefers-color-scheme: dark`.
//
// XAML writes colors as #AARRGGBB while CSS writes #RRGGBBAA, so every value
// below is the XAML literal with its leading alpha byte moved to the end. Six
// digit XAML literals are already opaque and carry over unchanged.
//
// Two families cannot be a plain literal transcription and say so at their own
// block: the accent ramp, whose base is a Windows-generated system color that
// no dictionary contains, and the composed strokes, which restate a
// LinearGradientBrush as inset box-shadows because the web has no
// absolute-mapped border brush.
//
// Both blocks target `.fui-FluentProvider`, the element that already carries
// Fluent's own token variables, so the WinUI vocabulary cascades alongside it.
export const winuiTokenCss = `
/* Control fills — the body of a button, combo box, or check box.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L219-L225 */
.fui-FluentProvider {
  --winui-control-fill-default: #ffffffb3;
  --winui-control-fill-secondary: #f9f9f980;
  --winui-control-fill-tertiary: #f9f9f94d;
  --winui-control-fill-disabled: #f9f9f94d;
  --winui-control-fill-transparent: #ffffff00;
  --winui-control-fill-input-active: #ffffff;
}

/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L15-L21 */
@media (prefers-color-scheme: dark) {
  .fui-FluentProvider {
    --winui-control-fill-default: #ffffff0f;
    --winui-control-fill-secondary: #ffffff15;
    --winui-control-fill-tertiary: #ffffff08;
    --winui-control-fill-disabled: #ffffff0b;
    --winui-control-fill-transparent: #ffffff00;
    --winui-control-fill-input-active: #1e1e1eb3;
  }
}

/* Control strokes — the 1px outline around a control, plus the strong variant
   the text-control bottom edge is painted with.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L243-L253 */
.fui-FluentProvider {
  --winui-control-stroke-default: #0000000f;
  --winui-control-stroke-secondary: #00000029;
  --winui-control-stroke-on-accent-default: #ffffff14;
  --winui-control-stroke-on-accent-secondary: #00000066;
  --winui-control-strong-stroke-default: #00000072;
  --winui-control-strong-stroke-disabled: #00000037;
}

/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L39-L49 */
@media (prefers-color-scheme: dark) {
  .fui-FluentProvider {
    --winui-control-stroke-default: #ffffff12;
    --winui-control-stroke-secondary: #ffffff18;
    --winui-control-stroke-on-accent-default: #ffffff14;
    --winui-control-stroke-on-accent-secondary: #00000023;
    --winui-control-strong-stroke-default: #ffffff8b;
    --winui-control-strong-stroke-disabled: #ffffff28;
  }
}

/* Subtle fills — the hover and pressed wash on otherwise chromeless surfaces
   such as list rows and transparent buttons.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L229-L231 */
.fui-FluentProvider {
  --winui-subtle-fill-transparent: #ffffff00;
  --winui-subtle-fill-secondary: #00000009;
  --winui-subtle-fill-tertiary: #00000006;
}

/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L25-L27 */
@media (prefers-color-scheme: dark) {
  .fui-FluentProvider {
    --winui-subtle-fill-transparent: #ffffff00;
    --winui-subtle-fill-secondary: #ffffff0f;
    --winui-subtle-fill-tertiary: #ffffff0a;
  }
}

/* Card and layer fills — translucent surfaces that sit on the solid background
   ramp rather than replacing it.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L250-L264 */
.fui-FluentProvider {
  --winui-card-background-fill-default: #ffffffb3;
  --winui-card-background-fill-secondary: #f6f6f680;
  --winui-card-stroke-default: #0000000f;
  --winui-layer-fill-default: #ffffff80;
}

/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L46-L60 */
@media (prefers-color-scheme: dark) {
  .fui-FluentProvider {
    --winui-card-background-fill-default: #ffffff0d;
    --winui-card-background-fill-secondary: #ffffff08;
    --winui-card-stroke-default: #00000019;
    --winui-layer-fill-default: #3a3a3a4c;
  }
}

/* Solid backgrounds — the opaque ramp everything translucent is composited on.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L272-L275 */
.fui-FluentProvider {
  --winui-solid-background-fill-base: #f3f3f3;
  --winui-solid-background-fill-secondary: #eeeeee;
  --winui-solid-background-fill-tertiary: #f9f9f9;
  --winui-solid-background-fill-quarternary: #ffffff;
}

/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L68-L71 */
@media (prefers-color-scheme: dark) {
  .fui-FluentProvider {
    --winui-solid-background-fill-base: #202020;
    --winui-solid-background-fill-secondary: #1c1c1c;
    --winui-solid-background-fill-tertiary: #282828;
    --winui-solid-background-fill-quarternary: #2c2c2c;
  }
}

/* Surface strokes and dividers — the outline of a flyout or dialog, and the
   hairline between list sections.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L254-L257 */
.fui-FluentProvider {
  --winui-surface-stroke-default: #75757566;
  --winui-surface-stroke-flyout: #0000000f;
  --winui-divider-stroke-default: #0000000f;
}

/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L50-L53 */
@media (prefers-color-scheme: dark) {
  .fui-FluentProvider {
    --winui-surface-stroke-default: #75757566;
    --winui-surface-stroke-flyout: #00000033;
    --winui-divider-stroke-default: #ffffff15;
  }
}

/* Text fills — the foreground ramp WinUI paints on any neutral surface.
   Inverse is the one that flips: it is the fill for text sitting on a surface
   from the opposite theme, so it carries the other dictionary's primary.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L209-L213 */
.fui-FluentProvider {
  --winui-text-fill-primary: #000000e4;
  --winui-text-fill-secondary: #0000009e;
  --winui-text-fill-tertiary: #00000072;
  --winui-text-fill-disabled: #0000005c;
  --winui-text-fill-inverse: #ffffff;
}

/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L5-L9 */
@media (prefers-color-scheme: dark) {
  .fui-FluentProvider {
    --winui-text-fill-primary: #ffffff;
    --winui-text-fill-secondary: #ffffffc5;
    --winui-text-fill-tertiary: #ffffff87;
    --winui-text-fill-disabled: #ffffff5d;
    --winui-text-fill-inverse: #000000e4;
  }
}

/* Accent fill ramp. WinUI paints AccentFillColorDefault/Secondary/Tertiary
   from the OS accent ramp — SystemAccentColorDark1 in light — at opacity
   1.0 / 0.9 / 0.8. That ramp is generated by Windows from the user's accent
   color and appears nowhere in the theme dictionaries, so we take the base
   from Fluent's brand token, which is likewise theme-aware, and reproduce only
   the opacity relationship the dictionaries do define. The base is therefore
   ours; the two opacities are WinUI's.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L329-L331 */
.fui-FluentProvider {
  --winui-accent-fill-default: var(--colorBrandBackground);
  --winui-accent-fill-secondary: color-mix(in srgb, var(--colorBrandBackground) 90%, transparent);
  --winui-accent-fill-tertiary: color-mix(in srgb, var(--colorBrandBackground) 80%, transparent);
}

/* The dark ramp is keyed off SystemAccentColorLight2 rather than Dark1, but at
   the same two opacities, so the brand-token substitution above covers both
   themes and no dark override is needed.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L125-L127 */

/* The disabled accent fill is a literal rather than a step of that ramp.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L242 */
.fui-FluentProvider {
  --winui-accent-fill-disabled: #00000037;
}

/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L38 */
@media (prefers-color-scheme: dark) {
  .fui-FluentProvider {
    --winui-accent-fill-disabled: #ffffff28;
  }
}

/* Text on and against accent.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L214-L218 */
.fui-FluentProvider {
  --winui-accent-text-fill-disabled: #0000005c;
  --winui-text-on-accent-fill-primary: #ffffff;
  --winui-text-on-accent-fill-secondary: #ffffffb3;
  --winui-text-on-accent-fill-disabled: #ffffff;
  --winui-text-on-accent-fill-selected-text: #ffffff;
}

/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L10-L14 */
@media (prefers-color-scheme: dark) {
  .fui-FluentProvider {
    --winui-accent-text-fill-disabled: #ffffff5d;
    --winui-text-on-accent-fill-primary: #000000;
    --winui-text-on-accent-fill-secondary: #00000080;
    --winui-text-on-accent-fill-disabled: #ffffff87;
    --winui-text-on-accent-fill-selected-text: #ffffff;
  }
}

/* Corner radii. WinUI declares these per theme dictionary but ships the same
   two values in all of them.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CornerRadius_themeresources.xaml#L13-L15 */
.fui-FluentProvider {
  --winui-control-corner-radius: 4px;
  --winui-overlay-corner-radius: 8px;
}

/* Composed strokes. WinUI outlines a control with a LinearGradientBrush mapped
   in absolute units — a 3px span for ControlElevationBorderBrush and
   AccentControlElevationBorderBrush, 2px for TextControlElevationBorderBrush —
   so one edge reads heavier than the other three regardless of how tall the
   control is. The web has no equivalent of an absolute-mapped brush used as a
   border, so each is provided twice:

   the *-shadow form is a set of inset box-shadows, which follows border-radius
   and needs no border box, and is what most surfaces should use; the
   *-border-color form is a border-color shorthand for the cases where a real
   1px border already exists and only its per-side color is in question.

   The shadow form paints each side as its own 1px inset rather than a full
   ring plus a heavier strip: box-shadow composites, so a translucent ring
   under a translucent strip would render the heavy edge darker than the XAML
   gradient ever gets. One deviation survives that split — the two pixels where
   the heavy edge meets a side edge are covered by both insets and composite
   there. A border-radius large enough to round those pixels away removes it. */

/* Light flips the gradient (ScaleY="-1"), putting the heavier
   ControlStrokeColorSecondary edge at the bottom.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L382-L390 */
.fui-FluentProvider {
  --winui-control-elevation-shadow:
    inset 0 1px 0 0 var(--winui-control-stroke-default),
    inset 1px 0 0 0 var(--winui-control-stroke-default),
    inset -1px 0 0 0 var(--winui-control-stroke-default),
    inset 0 -1px 0 0 var(--winui-control-stroke-secondary);
  --winui-control-elevation-border-color:
    var(--winui-control-stroke-default)
    var(--winui-control-stroke-default)
    var(--winui-control-stroke-secondary);
}

/* Dark leaves the gradient unflipped, so the brighter edge sits at the top.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L186-L191 */
@media (prefers-color-scheme: dark) {
  .fui-FluentProvider {
    --winui-control-elevation-shadow:
      inset 0 1px 0 0 var(--winui-control-stroke-secondary),
      inset 1px 0 0 0 var(--winui-control-stroke-default),
      inset -1px 0 0 0 var(--winui-control-stroke-default),
      inset 0 -1px 0 0 var(--winui-control-stroke-default);
    --winui-control-elevation-border-color:
      var(--winui-control-stroke-secondary)
      var(--winui-control-stroke-default)
      var(--winui-control-stroke-default);
  }
}

/* The text-control stroke carries ScaleY="-1" in both dictionaries, so its
   heavy edge is at the bottom either way; that edge is
   ControlStrongStrokeColorDefault, which is what gives a TextBox its
   pronounced underline. Both inputs are already theme-aware, so this needs no
   dark override.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L48-L56
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L155-L163 */
.fui-FluentProvider {
  --winui-text-control-elevation-shadow:
    inset 0 1px 0 0 var(--winui-control-stroke-default),
    inset 1px 0 0 0 var(--winui-control-stroke-default),
    inset -1px 0 0 0 var(--winui-control-stroke-default),
    inset 0 -1px 0 0 var(--winui-control-strong-stroke-default);
  --winui-text-control-elevation-border-color:
    var(--winui-control-stroke-default)
    var(--winui-control-stroke-default)
    var(--winui-control-strong-stroke-default);
}

/* The accent outline is the same construction over the on-accent strokes, and
   is likewise flipped in both dictionaries.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L198-L206
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L397-L405 */
.fui-FluentProvider {
  --winui-accent-control-elevation-shadow:
    inset 0 1px 0 0 var(--winui-control-stroke-on-accent-default),
    inset 1px 0 0 0 var(--winui-control-stroke-on-accent-default),
    inset -1px 0 0 0 var(--winui-control-stroke-on-accent-default),
    inset 0 -1px 0 0 var(--winui-control-stroke-on-accent-secondary);
  --winui-accent-control-elevation-border-color:
    var(--winui-control-stroke-on-accent-default)
    var(--winui-control-stroke-on-accent-default)
    var(--winui-control-stroke-on-accent-secondary);
}

/* Unresolved: TextControlElevationBorderFocusedBrush, the outline a focused
   TextBox draws, is not emitted. Its heavy stop is SystemAccentColorDark1 — a
   Windows-generated system color absent from every theme dictionary — and
   unlike the accent fill ramp it has no accompanying opacity relationship to
   restate, so there is nothing here to transcribe.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L164-L172 */
`;
