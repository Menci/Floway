// Button and ToggleButton, restyled from Fluent 2 Web onto WinUI 3.
//
// The foundation layer already re-points Fluent's neutral ramps at WinUI
// values, so this file only carries what still disagrees after that remap:
// WinUI's translucent control fill, its accent ramp for the primary and
// checked appearances, its flat foreground on chromeless buttons, its
// elevation strokes, its focus rings, and its geometry.
//
// Two axes select a WinUI trait, and both are addressable in the DOM. The
// appearance arrives as `data-winui-appearance`, stamped by `winui/appearance`;
// the checked state arrives as Fluent's own `aria-pressed`, or `aria-checked`
// when the role is checkbox-like. A trait that belongs to one appearance is
// therefore written as an ordinary property under the matching attribute
// selector, and geometry, which WinUI states identically for every variant, is
// written on the root.
//
// Colour that a Fluent token already partitions the same way WinUI does stays
// token redefinition: `--colorBrandBackground*` is read by the primary atoms
// alone and `--colorNeutralForeground2*` by the chromeless ones, so
// redefining those is both shorter and less likely to collide with a Griffel
// atom than restating the property per state.
//
// Rules are scoped under `.fui-FluentProvider`, which is also where the WinUI
// variables are declared, so each override sits at least one class above
// Griffel's single-class atoms.
export const buttonCss = `
/* Geometry and typography. The weight is Normal rather than Fluent's semibold,
   and the style declares neither MinWidth nor MaxWidth, so a WinUI button is
   sized by its content instead of reserving Fluent's 96px. The same padding
   covers the icon-only button: WinUI states no separate square style for it,
   and Fluent's 32px square is not addressable anyway, since iconOnly reaches
   the DOM only as a hashed atom and an icon-only root is structurally
   identical to an icon-plus-label one whose label is a bare text node.
   BackgroundSizing is InnerBorderEdge, which is background-clip: padding-box on
   the web: the fill stops at the border rather than running underneath it, so a
   translucent border reads against the surface behind the control and not
   against its own fill.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L154-L168
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleButton_themeresources.xaml#L182-L190 */
.fui-FluentProvider .fui-Button {
  padding: var(--winui-button-padding);
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
   fill on hover and drops to the secondary fill only while pressed. Both
   tokens are read by the appearances that have a neutral fill, which is the
   same partition WinUI draws.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L128-L139
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L30-L41 */
.fui-FluentProvider .fui-Button {
  --colorNeutralBackground1: var(--winui-control-fill-default);
  --colorNeutralForeground1Hover: var(--winui-text-fill-primary);
  --colorNeutralForeground1Pressed: var(--winui-text-fill-secondary);
  --colorNeutralBackgroundDisabled: var(--winui-control-fill-disabled);
}

/* The elevation stroke. ButtonBorderBrush is ControlElevationBorderBrush, a
   vertical gradient whose heavier ControlStrokeColorSecondary stop sits at the
   bottom edge in light and the top edge in dark; the foundation already
   transcribes it as a three-term border-colour, so the rule here only has to
   reach the appearances that own it. Fluent's outline appearance keeps its
   transparent fill and takes the same stroke — WinUI has no chromeless-but-
   outlined button, so the two share the default's border. Hover repeats the
   rest brush, which the rest declaration already outranks; pressed and disabled
   both fall back to the flat ControlStrokeColorDefault.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L136-L139
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L38-L41 */
.fui-FluentProvider .fui-Button[data-winui-appearance='secondary'],
.fui-FluentProvider .fui-Button[data-winui-appearance='outline'] {
  border-color: var(--winui-control-elevation-border-color);
}

.fui-FluentProvider .fui-Button[data-winui-appearance='secondary']:hover:active,
.fui-FluentProvider .fui-Button[data-winui-appearance='outline']:hover:active,
.fui-FluentProvider .fui-Button[data-winui-appearance='secondary']:disabled,
.fui-FluentProvider .fui-Button[data-winui-appearance='outline']:disabled,
.fui-FluentProvider .fui-Button[data-winui-appearance='secondary'][aria-disabled='true'],
.fui-FluentProvider .fui-Button[data-winui-appearance='outline'][aria-disabled='true'] {
  border-color: var(--winui-control-stroke-default);
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

/* An accent button carries the on-accent elevation stroke, and it drops to the
   transparent control fill under a press and while disabled. Its disabled fill
   and label are the accent-specific pair rather than the neutral disabled ramp
   the rest of the button family shares — Fluent reads both from the neutral
   tokens, so they are restated here rather than redefined.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L106-L114
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L8-L16 */
.fui-FluentProvider .fui-Button[data-winui-appearance='primary'] {
  border-color: var(--winui-accent-control-elevation-border-color);
}

.fui-FluentProvider .fui-Button[data-winui-appearance='primary']:hover:active {
  border-color: var(--winui-control-fill-transparent);
}

.fui-FluentProvider .fui-Button[data-winui-appearance='primary']:disabled,
.fui-FluentProvider .fui-Button[data-winui-appearance='primary'][aria-disabled='true'] {
  background-color: var(--winui-accent-fill-disabled);
  border-color: var(--winui-control-fill-transparent);
  color: var(--winui-text-on-accent-fill-disabled);
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

/* The focus visual. WinUI draws two concentric rings, FocusStrokeColorInner
   against the control edge and the contrasting FocusStrokeColorOuter around
   it, so the indicator survives on any fill including accent. Fluent builds
   the same two rings out of a border plus an outline one step further out, and
   leaves the outer one transparent; recolouring its two inputs therefore
   yields WinUI's visual without restating any ring width, which the Button
   style does not declare. The rule also has to outrank the elevation strokes
   above, which is why the border colour is repeated here.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L258-L259
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L54-L55 */
.fui-FluentProvider .fui-Button[data-winui-appearance][data-fui-focus-visible] {
  --colorStrokeFocus2: var(--winui-focus-stroke-inner);
  --colorTransparentStroke: var(--winui-focus-stroke-outer);
  border-color: var(--winui-focus-stroke-inner);
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
   accent, and an on-accent label that dims only while pressed. Fluent has no
   selected variant of any of these: its checked atoms reuse the unchecked hover
   and pressed tokens, so the redefinitions have to be gated on the checked
   state itself rather than sitting on the root beside the block above, which
   would repaint an unchecked toggle.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleButton_themeresources.xaml#L128-L141
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleButton_themeresources.xaml#L12-L25 */
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
}

/* Checked chrome. The stroke is the on-accent elevation gradient, held through
   hover and cleared to the transparent control fill under a press and while
   disabled, and the checked visual states also swap BackgroundSizing to
   OuterBorderEdge — background-clip: border-box on the web — so the accent
   fill runs under the stroke instead of stopping at it.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleButton_themeresources.xaml#L122
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleButton_themeresources.xaml#L151-L154
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleButton_themeresources.xaml#L35-L38 */
.fui-FluentProvider .fui-ToggleButton[aria-pressed='true'],
.fui-FluentProvider .fui-ToggleButton[aria-checked='true'] {
  background-clip: border-box;
  border-color: var(--winui-accent-control-elevation-border-color);
}

.fui-FluentProvider .fui-ToggleButton[aria-pressed='true']:hover:active,
.fui-FluentProvider .fui-ToggleButton[aria-checked='true']:hover:active {
  border-color: var(--winui-control-fill-transparent);
}

/* A disabled checked toggle keeps the accent ramp rather than falling back to
   the neutral disabled fill, which is what Fluent's checked-disabled atoms
   otherwise resolve to.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleButton_themeresources.xaml#L130
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleButton_themeresources.xaml#L142
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleButton_themeresources.xaml#L154 */
.fui-FluentProvider .fui-ToggleButton[aria-pressed='true']:disabled,
.fui-FluentProvider .fui-ToggleButton[aria-checked='true']:disabled,
.fui-FluentProvider .fui-ToggleButton[aria-pressed='true'][aria-disabled='true'],
.fui-FluentProvider .fui-ToggleButton[aria-checked='true'][aria-disabled='true'] {
  background-color: var(--winui-accent-fill-disabled);
  border-color: var(--winui-control-fill-transparent);
  color: var(--winui-text-on-accent-fill-disabled);
}
`;
