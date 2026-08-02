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
//
// The rules below stop at the boundary of a subtree that opts out of the layer;
// see ../tokens.ts for the convention.

import { notOptedOut } from '../tokens';

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

// Fluent states its pressed step on `:hover:active` and on
// `:active:focus-visible`, so that a space or enter press reaches it as well as
// a pointer one. A rule restating a pressed value has to name the same pair, or
// the keyboard press keeps the rest value.
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-button/library/src/components/Button/useButtonStyles.styles.ts#L55
const pressedStates = [':hover:active', ':active:focus-visible'];

// Fluent's `disabledFocusable` keeps the element enabled to the browser and
// says so with `aria-disabled`, so both spellings name the disabled visual.
const disabledStates = [':disabled', `[aria-disabled='true']`];

// Fluent colours the icon of a chromeless or disabled button through a
// descendant rule of its own rather than letting it inherit, so a colour stated
// on the root reaches the label and not the glyph.
const withIcon = (states: readonly string[]) =>
  states.map(state => `${state} .fui-Button__icon`);

const appearanceRoot = (appearance: string) =>
  `.fui-Button.fui-Button[data-winui-appearance='${appearance}']${notOptedOut}`;

// The appearances that carry a neutral fill and the elevation stroke.
const neutral = (states: readonly string[] = ['']) =>
  expand(['secondary', 'outline'], states, appearanceRoot);

// The two chromeless appearances, minus the checked state, which paints itself
// from the accent family instead, and minus the disabled one, which takes the
// same disabled foreground every other appearance takes.
const enabledUnchecked = (appearance: string) =>
  `${appearanceRoot(appearance)}:not([aria-pressed='true'])`
  + `:not([aria-checked='true']):not(:disabled):not([aria-disabled='true'])`;

const chromeless = (states: readonly string[] = ['']) =>
  expand(['subtle', 'transparent'], states, enabledUnchecked);

const transparentOnly = (states: readonly string[] = ['']) =>
  expand(['transparent'], states, enabledUnchecked);

// Every selector nested in the forced-colours guard below is interpolated at
// the start of a line, so the indent it would have been written with has to
// come from here.
const nested = (selectorList: string) => selectorList
  .split('\n')
  .map(line => `  ${line}`)
  .join('\n');

const checkedToggle = (states: readonly string[] = ['']) => expand(
  [`[aria-pressed='true']`, `[aria-checked='true']`],
  states,
  flag => `.fui-ToggleButton.fui-ToggleButton${flag}${notOptedOut}`,
);

export const buttonCss = `
/* Geometry and typography. The weight is Normal rather than Fluent's semibold,
   and the style declares neither MinWidth nor MaxWidth, so a WinUI button is
   sized by its content instead of reserving Fluent's 96px. BackgroundSizing is
   InnerBorderEdge, which ../reset.css.ts already applies to everything; it is
   named here because the two rules below depart from it.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L154-L168
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleButton_themeresources.xaml#L182-L190 */
.fui-Button.fui-Button${notOptedOut} {
  font-weight: var(--fontWeightRegular);
  min-width: auto;
  max-width: none;
}

/* AccentButtonStyle is the one variant that states OuterBorderEdge instead,
   and states it as a Setter rather than in a visual state, so an accent
   button's fill runs under its stroke in every state it has.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L235-L238 */
${appearanceRoot('primary')} {
  background-clip: border-box;
}

/* The checked visual states of a ToggleButton swap BackgroundSizing the same
   way, so a checked toggle reads as an accent button does. CheckedDisabled
   carries no such keyframe and keeps the template's InnerBorderEdge, which is
   visible because the checked disabled stroke is the transparent control fill.
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

/* ButtonPadding is the padding of a button that carries a label. CSS cannot
   tell a label apart from an icon -- a label is a text node and the icon is the
   only element child either way -- so excluding every button that has an icon
   keeps the icon-only ones on Fluent's square, at the cost of a pixel of
   horizontal padding and one bottom pixel on an icon-and-label button.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L152 */
.fui-Button.fui-Button:not(:has(> .fui-Button__icon))${notOptedOut} {
  padding: var(--winui-button-padding);
}

/* WinUI animates the fill alone, and only for the ControlFasterAnimationDuration
   of the content presenter's BrushTransition; border and foreground switch
   instantly.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L172-L174
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L606 */
.fui-Button.fui-Button${notOptedOut} {
  transition-property: background-color;
  transition-duration: var(--winui-control-faster-animation-duration);
}

@media (prefers-reduced-motion: reduce) {
  .fui-Button.fui-Button${notOptedOut} {
    transition-duration: 0.01ms;
  }
}

@media not (forced-colors: active) {
  /* The default and outline appearances. A WinUI button's fill is translucent
     where Fluent's Background1 is opaque; its label holds at the primary text
     fill on hover and drops to the secondary fill only while pressed.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L128-L139
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L30-L41 */
  .fui-Button.fui-Button${notOptedOut} {
    --colorNeutralBackground1: var(--winui-control-fill-default);
    --colorNeutralForeground1Hover: var(--winui-text-fill-primary);
    --colorNeutralForeground1Pressed: var(--winui-text-fill-secondary);
    --colorNeutralBackgroundDisabled: var(--winui-control-fill-disabled);
  }

  /* The elevation stroke, which the foundation already transcribes as a
     three-term border-colour. Fluent's outline appearance has no WinUI
     counterpart, so it is handed the default button's elevation stroke and the
     two read as a pair. Pressed and disabled both fall back to the flat
     ControlStrokeColorDefault.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L136-L139
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L38-L41 */
${nested(neutral())} {
    border-color: var(--winui-control-elevation-border-color);
  }

${nested(neutral([...pressedStates, ...disabledStates]))} {
    border-color: var(--winui-control-stroke-default);
  }

  /* The primary appearance is WinUI's AccentButtonStyle, whose interaction steps
     are the rest accent at 90% and 80% opacity rather than separate hues, so all
     three have to come from one colour and the rest step is stated here beside
     them. Left to Fluent it is the product's brand fill, a different blue, which
     in dark puts WinUI's on-accent label -- black against a light accent -- on a
     dark brand fill.

     Each step is a declaration rather than a redefinition of the brand token
     Fluent reads, because a custom property handed to the button root reaches
     everything inside it.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L103-L109
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L5-L11 */
${nested(appearanceRoot('primary'))} {
    background-color: var(--winui-accent-fill-default);
    border-color: var(--winui-accent-control-elevation-border-color);
  }

${nested(appearanceRoot('primary'))}:hover {
    background-color: var(--winui-accent-fill-secondary);
  }

${nested(expand(['primary'], pressedStates, appearanceRoot))} {
    background-color: var(--winui-accent-fill-tertiary);
    border-color: var(--winui-control-fill-transparent);
  }

  /* A disabled accent button keeps the accent-specific fill and label rather
     than the neutral disabled ramp the rest of the family shares. The glyph is
     named separately from the label, or the disabled label would sit on the
     on-accent white beside an icon on the neutral disabled foreground.
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

  /* The subtle and transparent appearances are both WinUI's SubtleButtonStyle.
     The foundation already re-points what subtle reads; transparent reads
     colorTransparentBackgroundHover/Pressed, which resolve to the transparent
     keyword in every Fluent theme and leave the variant with no pointer feedback
     at all. Those two steps are stated as properties rather than through the
     tokens, because the same two tokens carry Fluent's disabled transparent
     button, which WinUI keeps at SubtleFillColorTransparent throughout.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L115-L118
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L17-L20 */
${nested(transparentOnly([':hover']))} {
    background-color: var(--winui-subtle-fill-secondary);
  }

${nested(transparentOnly(pressedStates))} {
    background-color: var(--winui-subtle-fill-tertiary);
  }

  /* The chromeless foreground. WinUI keeps a chromeless button's label and
     icon at the full primary text fill and dims them to the secondary fill only
     while pressed, where Fluent runs them at the secondary fill throughout and
     tints them toward the brand on hover.

     Stated as a colour rather than as a redefinition of the token Fluent reads:
     a button is free to hold more than a label, and a custom property handed to
     the root would override a descendant that names its own fill, where an
     inherited colour does not. The glyph is one such descendant -- Fluent gives
     a chromeless button's icon the brand tint through a rule of its own -- so
     the icon is named beside the label.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L119-L121
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L21-L23 */
${nested(chromeless(['', ':hover', ...withIcon([':hover'])]))} {
    color: var(--winui-text-fill-primary);
  }

${nested(chromeless([...pressedStates, ...withIcon(pressedStates)]))} {
    color: var(--winui-text-fill-secondary);
  }

  /* The focus visual. WinUI draws two concentric rings so the indicator survives
     on any fill including accent; Fluent builds the same two out of a border plus
     an outline one step further out and leaves the outer one transparent, so
     recolouring its two inputs yields WinUI's pairing. Fluent's construction and
     ring widths are kept as the web idiom -- so the inner ring reads 2px where
     DefaultFocusVisualSecondaryThickness is 1, and the rings sit flush against
     the control where FocusVisualMargin -3 would push them three pixels clear.
     The rule also has to outrank the elevation strokes above, which is why the
     border colour is repeated here.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L258-L259
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L54-L55
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L167
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/components/DependencyObject/DependencyProperty.cpp#L24-L25
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/components/math/math.cpp#L1374-L1381 */
  .fui-Button.fui-Button[data-winui-appearance][data-fui-focus-visible]${notOptedOut} {
    --colorStrokeFocus2: var(--winui-focus-stroke-inner);
    --colorTransparentStroke: var(--winui-focus-stroke-outer);
    border-color: var(--winui-focus-stroke-inner);
  }

  /* A checked ToggleButton is an accent button in WinUI, whatever the unchecked
     appearance was, so every selected token converges on the accent fill and the
     on-accent label.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleButton_themeresources.xaml#L127-L151
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleButton_themeresources.xaml#L11-L35 */
  .fui-ToggleButton.fui-ToggleButton${notOptedOut} {
    --colorNeutralBackground1Selected: var(--winui-accent-fill-default);
    --colorSubtleBackgroundSelected: var(--winui-accent-fill-default);
    --colorTransparentBackgroundSelected: var(--winui-accent-fill-default);
    --colorBrandBackgroundSelected: var(--winui-accent-fill-default);
    --colorNeutralForeground1Selected: var(--winui-text-on-accent-fill-primary);
    --colorNeutralForeground2Selected: var(--winui-text-on-accent-fill-primary);
    --colorNeutralForeground2BrandSelected: var(--winui-text-on-accent-fill-primary);
  }

  /* Checked hover and pressed continue the accent ramp -- 90% and 80% of the rest
     accent, and an on-accent label that dims only while pressed. Fluent has no
     selected variant of any of these: its checked atoms reuse the unchecked hover
     and pressed tokens, so the redefinitions have to be gated on the checked
     state itself rather than sitting on the root beside the block above, which
     would repaint an unchecked toggle. The brand-tinted foreground tokens are in
     the list because Fluent reads them for the glyph of a checked subtle or
     transparent toggle.
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

  /* Checked chrome. The stroke is the on-accent elevation gradient, held through
     hover and cleared to the transparent control fill under a press.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleButton_themeresources.xaml#L151-L153
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleButton_themeresources.xaml#L35-L37 */
${nested(checkedToggle())} {
    border-color: var(--winui-accent-control-elevation-border-color);
  }

${nested(checkedToggle(pressedStates))} {
    border-color: var(--winui-control-fill-transparent);
  }

  /* A disabled checked toggle keeps the accent ramp rather than falling back to
     the neutral disabled fill, which is what Fluent's checked-disabled atoms
     otherwise resolve to, and its glyph is named beside its label for the same
     reason an accent button's is.
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
