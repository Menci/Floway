// Button and ToggleButton, restyled from Fluent 2 Web onto WinUI 3.
//
// The foundation layer already re-points Fluent's neutral ramps at WinUI
// values, so this file only carries what still disagrees after that remap:
// WinUI's translucent control fill, its accent ramp for the primary and
// checked appearances, its flat foreground on chromeless buttons, and its
// geometry.
//
// Appearance is not on the DOM — Fluent expresses `primary`, `subtle`,
// `transparent`, and `outline` purely as hashed Griffel atoms — so a plain
// `background-color` override on the root would repaint every variant at once.
// The colour work is therefore written as token redefinition scoped to the
// button element: each Fluent variable below is read by exactly the variants
// that should change, and the atoms of the other variants never reference it.
// Geometry, which WinUI states identically for every variant, is set directly.
//
// Rules are scoped under `.fui-FluentProvider`, which is also where the WinUI
// variables are declared, so each override sits one class above Griffel's
// single-class atoms. The colour rules are then grouped by which set of
// variants reads them, one group per rule, because that grouping is the only
// thing keeping each redefinition off the variants it must not touch.
export const buttonCss = `
/* Geometry and typography. ButtonPadding is asymmetric — one pixel more below
   than above — the weight is Normal rather than Fluent's semibold, and the
   style declares neither MinWidth nor MaxWidth, so a WinUI button is sized by
   its content instead of reserving Fluent's 96px. The same padding covers the
   icon-only button: WinUI states no separate square style for it, and Fluent's
   32px square is not addressable anyway, since iconOnly reaches the DOM only
   as a hashed atom and an icon-only root is structurally identical to an
   icon-plus-label one whose label is a bare text node. BackgroundSizing is
   InnerBorderEdge, which is background-clip: padding-box on the web: the fill
   stops at the border rather than running underneath it, so a translucent
   border reads against the surface behind the control and not against its own
   fill.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L152
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L154-L168 */
.fui-FluentProvider .fui-Button {
  padding: 5px 11px 6px;
  min-width: auto;
  max-width: none;
  background-clip: padding-box;
  font-weight: var(--fontWeightRegular);
}

/* WinUI animates the fill alone, and only for the 83ms of the content
   presenter's BrushTransition; border and foreground switch instantly.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L172-L174 */
.fui-FluentProvider .fui-Button {
  transition-property: background-color;
  transition-duration: 83ms;
}

/* The default and outline appearances. A WinUI button's fill is translucent
   where Fluent's Background1 is opaque; its label holds at the primary text
   fill on hover and drops to the secondary fill only while pressed; its outline
   holds still on hover, because ButtonBorderBrushPointerOver is the same
   ControlElevationBorderBrush as at rest while Fluent's reset steps up to the
   heavy stroke, so hover is pinned to what rest already resolves to; and
   its disabled outline is the ordinary control stroke rather than a heavier
   disabled one.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L128-L139
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L30-L41

   Two WinUI traits of these appearances are out of reach, both for the same
   reason: appearance never reaches the DOM, so no rule can name one variant.
   ButtonBorderBrush is a gradient, ControlElevationBorderBrush, whose heavier
   stop sits at the bottom edge in light and the top edge in dark; a per-side
   border-colour on the root would outrank the transparent borders that the
   primary, subtle, and transparent atoms paint, so the flat stroke stands in
   for it. And the disabled fill below is read by disabled primary too — Fluent
   overrides only the borders there — where WinUI asks for
   AccentFillColorDisabled, so a disabled accent button follows the neutral
   disabled fill.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L136
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L106 */
.fui-FluentProvider .fui-Button {
  --colorNeutralBackground1: var(--winui-control-fill-default);
  --colorNeutralForeground1Hover: var(--winui-text-fill-primary);
  --colorNeutralForeground1Pressed: var(--winui-text-fill-secondary);
  --colorNeutralStroke1Hover: var(--winui-control-stroke-default);
  --colorNeutralBackgroundDisabled: var(--winui-control-fill-disabled);
  --colorNeutralStrokeDisabled: var(--winui-control-stroke-default);
}

/* The primary appearance is WinUI's AccentButtonStyle, whose interaction steps
   are the rest accent at 90% and 80% opacity rather than separate hues. The
   rest fill and the on-accent label already agree through the brand tokens.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L103-L109
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L5-L11 */
.fui-FluentProvider .fui-Button {
  --colorBrandBackgroundHover: var(--winui-accent-fill-secondary);
  --colorBrandBackgroundPressed: var(--winui-accent-fill-tertiary);
}

/* The subtle and transparent appearances are both WinUI's SubtleButtonStyle,
   whose three fills already match Fluent's subtle fills. What differs is the
   foreground: WinUI keeps a chromeless button's label and icon at the full
   primary text fill and dims them to the secondary fill only while pressed,
   where Fluent runs them at the secondary fill throughout and tints them
   toward the brand on hover. These Foreground2 tokens are read only by the
   chromeless variants.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L119-L121
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L21-L23 */
.fui-FluentProvider .fui-Button {
  --colorNeutralForeground2: var(--winui-text-fill-primary);
  --colorNeutralForeground2Hover: var(--winui-text-fill-primary);
  --colorNeutralForeground2Pressed: var(--winui-text-fill-secondary);
  --colorNeutralForeground2BrandHover: var(--winui-text-fill-primary);
  --colorNeutralForeground2BrandPressed: var(--winui-text-fill-secondary);
}

/* A checked ToggleButton is an accent button in WinUI, whatever the unchecked
   appearance was, so every selected token converges on the accent fill and the
   on-accent label. These tokens are read only by the checked atoms, which is
   what keeps the unchecked states above intact.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleButton_themeresources.xaml#L127-L151
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleButton_themeresources.xaml#L11-L35 */
.fui-FluentProvider .fui-ToggleButton {
  --colorNeutralBackground1Selected: var(--winui-accent-fill-default);
  --colorSubtleBackgroundSelected: var(--winui-accent-fill-default);
  --colorTransparentBackgroundSelected: var(--winui-accent-fill-default);
  --colorBrandBackgroundSelected: var(--winui-accent-fill-default);
  --colorNeutralForeground1Selected: var(--winui-text-on-accent-fill-primary);
  --colorNeutralForeground2Selected: var(--winui-text-on-accent-fill-primary);
  --colorNeutralForeground2BrandSelected: var(--winui-text-on-accent-fill-primary);
}

/* Checked hover and pressed continue the accent ramp — 90% and 80% of the rest
   accent, an on-accent label that dims only while pressed, the on-accent
   elevation stroke standing in for its gradient, and a border that clears to
   the transparent control fill under the press. Fluent has no selected variant
   of any of these: its checked atoms reuse the unchecked hover and pressed
   tokens, so the redefinitions have to be gated on the checked state itself
   rather than sitting on the root beside the block above, which would repaint
   an unchecked toggle. The state does reach the DOM — the root carries
   aria-pressed, or aria-checked when the role is checkbox-like.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleButton_themeresources.xaml#L127-L157
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleButton_themeresources.xaml#L11-L41 */
.fui-FluentProvider .fui-ToggleButton[aria-pressed='true'],
.fui-FluentProvider .fui-ToggleButton[aria-checked='true'] {
  --colorNeutralBackground1Hover: var(--winui-accent-fill-secondary);
  --colorSubtleBackgroundHover: var(--winui-accent-fill-secondary);
  --colorTransparentBackgroundHover: var(--winui-accent-fill-secondary);
  --colorNeutralBackground1Pressed: var(--winui-accent-fill-tertiary);
  --colorSubtleBackgroundPressed: var(--winui-accent-fill-tertiary);
  --colorTransparentBackgroundPressed: var(--winui-accent-fill-tertiary);
  --colorNeutralForeground1Hover: var(--winui-text-on-accent-fill-primary);
  --colorNeutralForeground2Hover: var(--winui-text-on-accent-fill-primary);
  --colorNeutralForeground2BrandHover: var(--winui-text-on-accent-fill-primary);
  --colorNeutralForeground1Pressed: var(--winui-text-on-accent-fill-secondary);
  --colorNeutralForeground2Pressed: var(--winui-text-on-accent-fill-secondary);
  --colorNeutralForeground2BrandPressed: var(--winui-text-on-accent-fill-secondary);
  --colorNeutralStroke1: var(--winui-control-stroke-on-accent-default);
  --colorNeutralStroke1Hover: var(--winui-control-stroke-on-accent-default);
  --colorNeutralStroke1Pressed: var(--winui-control-fill-transparent);
}
`;
