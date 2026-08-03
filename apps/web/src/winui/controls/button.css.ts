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
// selector, and what WinUI states identically for every variant is written on
// the root.
//
// Colour that a Fluent token already partitions the same way WinUI does stays
// token redefinition: the checked ToggleButton's whole state table reads the
// neutral selected and interactive ramps, so redefining those is both shorter
// and less likely to collide with a Griffel atom than restating the property
// per state. Anything a button's contents could also read is stated as the
// property instead — a variable handed to the root reaches every descendant,
// and a caller is free to put more than a label inside a button.
//
// Colour is confined to `@media not (forced-colors: active)`. Fluent already
// carries a High Contrast map, and takes `forced-color-adjust: none` on the
// buttons whose map has to paint rather than be substituted by the user agent;
// a WinUI colour stated outside the guard would outrank that map wherever the
// adjust is off. Geometry, background sizing and the fill transition apply in
// both modes.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L53-L101

import { disabledStates, nested, notDisabled, reducedMotion } from './selectors';

// A suffix on a selector list attaches to its last item alone, so appending a
// state to an already joined string silently leaves every variant but the last
// matched in every state it has. Each variant is therefore expanded against
// each state before the join.
const expand = (
  variants: readonly string[],
  states: readonly string[],
  base: (variant: string) => string,
) => variants
  .flatMap(variant => states.map(state => `${base(variant)}${state}`))
  .join(',\n');

const restState = notDisabled;

const hoverStates = [`:hover${notDisabled}`];

// Fluent states its pressed step on `:hover:active` and on
// `:active:focus-visible`, so that a space or enter press reaches it as well as
// a pointer one. A rule restating a pressed value has to name the same pair, or
// the keyboard press keeps the rest value.
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-button/library/src/components/Button/useButtonStyles.styles.ts#L55
const pressedStates = [
  `:hover:active${notDisabled}`,
  `:active:focus-visible${notDisabled}`,
];

// Fluent colours the icon of a chromeless or disabled button through a
// descendant rule of its own rather than letting it inherit, so a colour stated
// on the root reaches the label and not the glyph.
const withIcon = (states: readonly string[]) =>
  states.map(state => `${state} .fui-Button__icon`);

const appearanceRoot = (appearance: string) =>
  `.fui-Button.fui-Button[data-winui-appearance='${appearance}']`;

// The appearances that carry a neutral fill and the elevation stroke.
const neutral = (states: readonly string[] = ['']) =>
  expand(['secondary', 'outline'], states, appearanceRoot);

// The two chromeless appearances, minus the checked state, which paints itself
// from the accent family instead.
const unchecked = (appearance: string) =>
  `${appearanceRoot(appearance)}:not([aria-pressed='true'])`
  + `:not([aria-checked='true'])`;

const chromeless = (states: readonly string[]) =>
  expand(['subtle', 'transparent'], states, unchecked);

const transparentOnly = (states: readonly string[]) =>
  expand(['transparent'], states, unchecked);

const checkedToggle = (states: readonly string[] = ['']) => expand(
  [`[aria-pressed='true']`, `[aria-checked='true']`],
  states,
  flag => `.fui-ToggleButton.fui-ToggleButton${flag}`,
);

export const buttonCss = `
/* Normal weight rather than Fluent's semibold, and neither MinWidth nor
   MaxWidth, so a WinUI button is sized by its content instead of reserving
   Fluent's 96px.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L154-L168
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleButton_themeresources.xaml#L182-L190 */
.fui-Button.fui-Button {
  font-weight: var(--fontWeightRegular);
  min-width: auto;
  max-width: none;
}

/* AccentButtonStyle is the one variant that states OuterBorderEdge, and states
   it as a Setter, so an accent fill runs under its stroke in every state.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L235-L238 */
${appearanceRoot('primary')} {
  background-clip: border-box;
}

/* A checked ToggleButton swaps BackgroundSizing the same way; CheckedDisabled
   carries no such keyframe and keeps the template's InnerBorderEdge.
   ToggleButtonBorderThemeThickness stays 1 across the whole state table, where
   Fluent doubles the stroke of a checked outline toggle.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleButton_themeresources.xaml#L122
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleButton_themeresources.xaml#L6
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleButton_themeresources.xaml#L244-L291
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleButton_themeresources.xaml#L292-L304
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleButton_themeresources.xaml#L121 */
${checkedToggle()} {
  background-clip: border-box;
  border-width: 1px;
}

${checkedToggle(disabledStates)} {
  background-clip: padding-box;
}

/* ButtonPadding is the padding of a button that carries a label, and CSS cannot
   tell a label apart from an icon, so excluding every button that has an icon
   keeps the icon-only ones on Fluent's square -- Fluent reaches its 32px square
   through even 5px padding around a 20px glyph, which holds on its own once the
   width reservation above is released.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L152 */
.fui-Button.fui-Button:not(:has(> .fui-Button__icon)) {
  padding: var(--winui-button-padding);
}

/* WinUI animates the fill alone, for the content presenter's BrushTransition
   duration; border and foreground switch instantly.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L172-L174
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L606 */
.fui-Button.fui-Button {
  transition-property: background-color;
  transition-duration: var(--winui-control-faster-animation-duration);
}

${reducedMotion(['.fui-Button.fui-Button'], 'transition-duration')}

@media not (forced-colors: active) {
  /* WinUI's fill is translucent where Fluent's Background1 is opaque, and its
     label holds at the primary text fill on hover, dropping to the secondary
     fill only while pressed.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L128-L139
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L30-L41 */
  .fui-Button.fui-Button {
    --colorNeutralBackground1: var(--winui-control-fill-default);
    --colorNeutralForeground1Hover: var(--winui-text-fill-primary);
    --colorNeutralForeground1Pressed: var(--winui-text-fill-secondary);
    --colorNeutralBackgroundDisabled: var(--winui-control-fill-disabled);
  }

  /* Fluent's outline appearance has no WinUI counterpart, so it is handed the
     default button's elevation stroke and the two read as a pair. Pressed and
     disabled both fall back to the flat ControlStrokeColorDefault.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L136-L139
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L38-L41 */
${nested(neutral())} {
    border-color: var(--winui-control-elevation-border-color);
  }

${nested(neutral([...pressedStates, ...disabledStates]))} {
    border-color: var(--winui-control-stroke-default);
  }

  /* WinUI's AccentButtonStyle derives its interaction steps from the rest accent
     at 90% and 80% opacity, so all three have to come from one colour. Left to
     Fluent it is the product's brand fill, which in dark puts WinUI's on-accent
     black label on a dark blue.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L103-L109
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L5-L11

     The pressed step also drops the label to the on-accent secondary fill, and
     that one is stated as a property: Fluent restates
     colorNeutralForegroundOnBrand inside the primary appearance's own pressed
     atom, so redefining the token on the root leaves the atom in charge.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L109
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L11 */
${nested(appearanceRoot('primary'))} {
    background-color: var(--winui-accent-fill-default);
    border-color: var(--winui-accent-control-elevation-border-color);
  }

${nested(expand(['primary'], hoverStates, appearanceRoot))} {
    background-color: var(--winui-accent-fill-secondary);
  }

${nested(expand(['primary'], pressedStates, appearanceRoot))} {
    background-color: var(--winui-accent-fill-tertiary);
    border-color: var(--winui-control-fill-transparent);
    color: var(--winui-text-on-accent-fill-secondary);
  }

  /* A disabled accent button keeps the accent ramp rather than the shared neutral
     one; the glyph is named separately or it would take the neutral disabled
     foreground beside an on-accent label.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L106-L114
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L8-L16 */
${nested(expand(['primary'], disabledStates, appearanceRoot))} {
    background-color: var(--winui-accent-fill-disabled);
    border-color: var(--winui-control-fill-transparent);
    color: var(--winui-text-on-accent-fill-disabled);
  }

${nested(expand(['primary'], withIcon(disabledStates), appearanceRoot))} {
    color: var(--winui-text-on-accent-fill-disabled);
  }

  /* Subtle and transparent are both WinUI's SubtleButtonStyle; transparent's
     Fluent hover/pressed tokens resolve to the transparent keyword, so its
     feedback is stated as properties -- those same tokens also carry Fluent's
     disabled transparent button, which WinUI leaves at SubtleFillColorTransparent.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L115-L118
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L17-L20 */
${nested(transparentOnly(hoverStates))} {
    background-color: var(--winui-subtle-fill-secondary);
  }

${nested(transparentOnly(pressedStates))} {
    background-color: var(--winui-subtle-fill-tertiary);
  }

  /* Stated as a colour rather than a redefinition of the token Fluent reads: a
     custom property on the button root would override a descendant that names
     its own fill, where an inherited colour does not. Fluent's brand tint on a
     chromeless icon is one such descendant, so the glyph is named beside the label.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L119-L121
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L21-L23 */
${nested(chromeless([restState, ...hoverStates, ...withIcon(hoverStates)]))} {
    color: var(--winui-text-fill-primary);
  }

${nested(chromeless([...pressedStates, ...withIcon(pressedStates)]))} {
    color: var(--winui-text-fill-secondary);
  }

  /* WinUI's two concentric rings map onto Fluent's border plus outline, so
     recolouring both inputs yields the pairing. Fluent's widths are kept as the
     web idiom: the inner ring is 2px where DefaultFocusVisualSecondaryThickness
     is 1, and the rings sit flush where FocusVisualMargin -3 would clear them by
     three pixels. The border colour is repeated to outrank the elevation strokes.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L258-L259
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L54-L55
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L167
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/components/DependencyObject/DependencyProperty.cpp#L24-L25
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/components/math/math.cpp#L1374-L1381 */
  .fui-Button.fui-Button[data-winui-appearance][data-fui-focus-visible] {
    --colorStrokeFocus2: var(--winui-focus-stroke-inner);
    --colorTransparentStroke: var(--winui-focus-stroke-outer);
    border-color: var(--winui-focus-stroke-inner);
  }

  /* Fluent gives the primary appearance alone a second inset stroke in the
     on-accent foreground, and withdraws it again on pointer-over. WinUI states
     no focus visual on AccentButtonStyle -- it sets no FocusVisual property and
     its storyboards move Background, BorderBrush and Foreground only -- so an
     accent button takes the same system ring as every other one, and the ring
     does not answer the pointer, CommonStates and FocusStates being separate
     groups. The two terms Fluent's own base focus style states are restated
     here through the same tokens, unconditionally so no interaction state can
     reintroduce the third, and the Firefox width correction is carried with
     them so the accent ring stays identical to its neighbours there too.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L235-L296
     https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-button/library/src/components/Button/useButtonStyles.styles.ts#L105-L122
     https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-button/library/src/components/Button/useButtonStyles.styles.ts#L473-L493
     https://bugzilla.mozilla.org/show_bug.cgi?id=1857642 */
  ${appearanceRoot('primary')}[data-fui-focus-visible] {
    box-shadow: 0 0 0 var(--strokeWidthThin) var(--colorStrokeFocus2) inset;
  }

  @supports (-moz-appearance: button) {
    ${appearanceRoot('primary')}[data-fui-focus-visible] {
      box-shadow: 0 0 0 calc(var(--strokeWidthThin) + 0.25px) var(--colorStrokeFocus2) inset;
    }
  }

  /* A checked ToggleButton is an accent button in WinUI, whatever the unchecked
     appearance was.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleButton_themeresources.xaml#L127-L151
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleButton_themeresources.xaml#L11-L35 */
  .fui-ToggleButton.fui-ToggleButton {
    --colorNeutralBackground1Selected: var(--winui-accent-fill-default);
    --colorSubtleBackgroundSelected: var(--winui-accent-fill-default);
    --colorTransparentBackgroundSelected: var(--winui-accent-fill-default);
    --colorBrandBackgroundSelected: var(--winui-accent-fill-default);
    --colorNeutralForeground1Selected: var(--winui-text-on-accent-fill-primary);
    --colorNeutralForeground2Selected: var(--winui-text-on-accent-fill-primary);
    --colorNeutralForeground2BrandSelected: var(--winui-text-on-accent-fill-primary);
  }

  /* Gated on the checked state rather than sitting on the root: Fluent's checked
     atoms reuse the unchecked hover and pressed tokens, so a root redefinition
     would repaint an unchecked toggle. The brand-tinted foregrounds are listed
     because Fluent reads them for a checked subtle or transparent toggle's glyph.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleButton_themeresources.xaml#L128-L141
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleButton_themeresources.xaml#L12-L25 */
${nested(checkedToggle())} {
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

  /* The same pressed foreground as the accent button, and stated the same way:
     a checked primary toggle reads colorNeutralForegroundOnBrand from its own
     appearance atom, which the redefinitions above do not name.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleButton_themeresources.xaml#L141
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleButton_themeresources.xaml#L25 */
${nested(checkedToggle(pressedStates))} {
    color: var(--winui-text-on-accent-fill-secondary);
  }

  /* The checked stroke is the on-accent elevation gradient.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleButton_themeresources.xaml#L151-L153
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleButton_themeresources.xaml#L35-L37 */
${nested(checkedToggle())} {
    border-color: var(--winui-accent-control-elevation-border-color);
  }

${nested(checkedToggle(pressedStates))} {
    border-color: var(--winui-control-fill-transparent);
  }

  /* A disabled checked toggle keeps the accent ramp rather than the neutral
     disabled fill Fluent's checked-disabled atoms otherwise resolve to.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleButton_themeresources.xaml#L130
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleButton_themeresources.xaml#L142
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleButton_themeresources.xaml#L154 */
${nested(checkedToggle(disabledStates))} {
    background-color: var(--winui-accent-fill-disabled);
    border-color: var(--winui-control-fill-transparent);
    color: var(--winui-text-on-accent-fill-disabled);
  }

${nested(checkedToggle(withIcon(disabledStates)))} {
    color: var(--winui-text-on-accent-fill-disabled);
  }
}
`;
