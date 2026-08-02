// The WinUI 3 color vocabulary, transcribed from the shipping theme resource
// dictionaries. In WinUI the dictionary keyed "Default" is the dark theme and
// "Light" is the light one; here the unqualified block is light and the dark
// values live under `prefers-color-scheme: dark`.
//
// XAML writes colors as #AARRGGBB while CSS writes #RRGGBBAA, so every value
// below is the XAML literal with its leading alpha byte moved to the end. Six
// digit XAML literals are already opaque and carry over unchanged.
//
// ---------------------------------------------------------------------------
// Selector convention for the whole WinUI override layer
// ---------------------------------------------------------------------------
//
// Every rule in `controls/` repeats the class of its subject — the rightmost
// compound. Context to the left stays single-classed:
//
//     .fui-DialogActions.fui-DialogActions { … }          /* about DialogActions */
//     .fui-DialogActions > .fui-Button.fui-Button { … }   /* about the button in it */
//     .fui-MenuList .fui-MenuItem.fui-MenuItem { … }      /* about the item in a list */
//
// The doubling is a specificity device and nothing else, so it applies once, to
// the subject. That puts the subject exactly one class above Griffel's
// single-class atoms, which is what makes the layer win regardless of stylesheet
// order. It outranks every single-class atom, not only Fluent's, so an app
// component restyling an element this layer paints has to escalate to
// !important; there is none anywhere in this directory, and one outside it
// should say at the declaration which rule here it is taking back, the way
// ../components/ui/danger.ts does.
//
// The rejected alternative was to scope each rule under an ancestor
// `.fui-FluentProvider`. It reaches portalled surfaces only while Fluent's
// `applyStylesToPortals` keeps its default — any consumer may set it to false,
// at which point every ancestor-scoped rule silently stops applying to dialogs,
// popovers, menus and tooltips. The layer should not rest on a prop we do not
// own.
//
// Two kinds of subject cannot take the doubled form, and both are deliberate. A
// rule about an element Fluent does not render — the OverlayScrollbars parts,
// the `.floway-*` elements our own wrappers add — has no `fui-` class to double
// and no Griffel atoms to beat. A rule about an unclassed descendant keeps the
// doubled Fluent subject in front of it and reaches the child with a combinator.
//
// Every `controls/*.css.ts` module is one TypeScript template literal, so a
// backtick anywhere inside it -- including inside a comment, where prose wants
// to quote a property name -- terminates the string. Write property names bare
// in these files.
//
// ---------------------------------------------------------------------------
// Opting a subtree out of the restyle
// ---------------------------------------------------------------------------
//
// `data-winui-card-restyle='off'` on an element withdraws from it, and from
// everything below it, the part of the layer that opted into the attribute.
// Surfaces designed against Fluent's own palette and elevations live under it —
// the playground transcript and composer above all.
//
// Two mechanisms carry it. A rule that reads a `--winui-*` custom property goes
// through an indirection declared on `:root` and reset to `initial` under the
// attribute, with the Fluent value as the `var()` fallback; a rule that cannot
// be expressed as a value — geometry, a new declaration Fluent does not make —
// excludes the subtree in its selector with
// `:not([data-winui-card-restyle='off'] *)`.
//
// Its reach is exactly the token indirections ./controls/card.css.ts declares
// plus the files that name the selector: ./reset.css.ts, and
// ./controls/{button,card,scrollbar,text-input,toolbar}.css.ts. Every geometry,
// glyph size and inset the other control files state still applies inside an
// opted-out subtree, so a control newly placed under the attribute has to be
// added to the guard deliberately.
//
// The attribute cannot reach a portalled surface: a tooltip, dialog or menu
// mounts under the provider root rather than under the element that opened it.
// A portalled surface that must not be restyled cannot be restyled at all.
//
// The `--winui-*` custom properties below are declared on `:root`, every one of
// them. They switch on `prefers-color-scheme`, never on the provider's `theme`
// prop, and no value here reads a Fluent theme variable, so nothing forces a
// narrower scope than the document root — which inherits into mount nodes under
// either setting of that prop.

import { COLLAPSE_ANIMATION_MS, CONTROL_FASTER_ANIMATION_MS, CONTROL_FAST_ANIMATION_MS, CONTROL_FAST_OUT_SLOW_IN_EASING, CONTROL_NORMAL_ANIMATION_MS, EXPAND_ANIMATION_MS, PAGE_ENTER_EASING, PAGE_ENTER_MS, PAGE_ENTER_OFFSET_PX, PAGE_LEAVE_EASING, PAGE_LEAVE_MS, REPOSITION_ANIMATION_MS, REPOSITION_EASING } from './motion';

// The selector half of the opt-out documented above. Rules that spend a token
// instead go through a `:root` indirection reset to `initial` there.
export const notOptedOut = `:not([data-winui-card-restyle='off'] *)`;

export const winuiTokenCss = `
/* Control fills — the body of a button, combo box, or check box.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L219-L225 */
:root {
  --winui-control-fill-default: #ffffffb3;
  --winui-control-fill-secondary: #f9f9f980;
  --winui-control-fill-tertiary: #f9f9f94d;
  --winui-control-fill-disabled: #f9f9f94d;
  --winui-control-fill-transparent: #ffffff00;
  --winui-control-fill-input-active: #ffffff;
}

/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L15-L21 */
@media (prefers-color-scheme: dark) {
  :root {
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
:root {
  --winui-control-stroke-default: #0000000f;
  --winui-control-stroke-secondary: #00000029;
  --winui-control-stroke-on-accent-default: #ffffff14;
  --winui-control-stroke-on-accent-secondary: #00000066;
  --winui-control-strong-stroke-default: #00000072;
  --winui-control-strong-stroke-disabled: #00000037;
}

/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L39-L49 */
@media (prefers-color-scheme: dark) {
  :root {
    --winui-control-stroke-default: #ffffff12;
    --winui-control-stroke-secondary: #ffffff18;
    --winui-control-stroke-on-accent-default: #ffffff14;
    --winui-control-stroke-on-accent-secondary: #00000023;
    --winui-control-strong-stroke-default: #ffffff8b;
    --winui-control-strong-stroke-disabled: #ffffff28;
  }
}

/* The control strong fill — the scroll bar thumb. It sits in the fill block of
   the dictionaries rather than with the strokes above, so it carries its own
   permalink.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L226 */
:root {
  --winui-control-strong-fill-default: #00000072;
}

/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L22 */
@media (prefers-color-scheme: dark) {
  :root {
    --winui-control-strong-fill-default: #ffffff8b;
  }
}

/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L229-L231 */
:root {
  --winui-subtle-fill-transparent: #ffffff00;
  --winui-subtle-fill-secondary: #00000009;
  --winui-subtle-fill-tertiary: #00000006;
}

/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L25-L27 */
@media (prefers-color-scheme: dark) {
  :root {
    --winui-subtle-fill-transparent: #ffffff00;
    --winui-subtle-fill-secondary: #ffffff0f;
    --winui-subtle-fill-tertiary: #ffffff0a;
  }
}

/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L250-L265 */
:root {
  --winui-card-background-fill-default: #ffffffb3;
  --winui-card-background-fill-secondary: #f6f6f680;
  --winui-card-stroke-default: #0000000f;
  --winui-layer-fill-default: #ffffff80;
  --winui-layer-fill-alt: #ffffff;
}

/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L46-L61 */
@media (prefers-color-scheme: dark) {
  :root {
    --winui-card-background-fill-default: #ffffff0d;
    --winui-card-background-fill-secondary: #ffffff08;
    --winui-card-stroke-default: #00000019;
    --winui-layer-fill-default: #3a3a3a4c;
    --winui-layer-fill-alt: #ffffff0d;
  }
}

/* The in-app acrylic material, taken as the flat FallbackColor the brush
   declares: CSS has no counterpart to WinUI's luminosity/tint/noise blend, so a
   surface filled with it reads opaque where WinUI lets the page through.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Materials/Acrylic/AcrylicBrush.cpp#L427-L470
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Materials/Acrylic/AcrylicBrush_themeresources.xaml#L96 */
:root {
  --winui-acrylic-in-app-fill-default: #f9f9f9;
}

/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Materials/Acrylic/AcrylicBrush_themeresources.xaml#L44 */
@media (prefers-color-scheme: dark) {
  :root {
    --winui-acrylic-in-app-fill-default: #2c2c2c;
  }
}

/* The tooltip drop shadow, the one overlay whose depth WinUI states in code
   rather than in a dictionary: ApplyElevationEffect(presenter, 0, 16), which
   the drop shadow recipe turns into blur 8, Y offset 4 and opacity 0.14 light
   against a flat 0.26 dark — the colors below. ./controls/tooltip.css.ts
   writes blur 9 instead: the compositor is handed the blur plus one, and that
   pixel pays for a caster inset on every side, which CSS cannot express.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/lib/ToolTip_Partial.cpp#L634-L653
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/components/graphics/ThemeShadow.cpp#L221-L228
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/lib/ElevationHelper.cpp#L19-L21
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/components/graphics/inc/DropShadowRecipe.h#L108-L162
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/components/comptree/HWCompNodeWinRT.cpp#L1608-L1675 */
:root {
  --winui-tooltip-shadow-color: #00000023;
}

@media (prefers-color-scheme: dark) {
  :root {
    --winui-tooltip-shadow-color: #00000042;
  }
}

/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L272-L279 */
:root {
  --winui-solid-background-fill-base: #f3f3f3;
  --winui-solid-background-fill-secondary: #eeeeee;
  --winui-solid-background-fill-tertiary: #f9f9f9;
  --winui-solid-background-fill-quarternary: #ffffff;
  --winui-solid-background-fill-base-alt: #dadada;
}

/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L68-L75 */
@media (prefers-color-scheme: dark) {
  :root {
    --winui-solid-background-fill-base: #202020;
    --winui-solid-background-fill-secondary: #1c1c1c;
    --winui-solid-background-fill-tertiary: #282828;
    --winui-solid-background-fill-quarternary: #2c2c2c;
    --winui-solid-background-fill-base-alt: #0a0a0a;
  }
}

/* Surface strokes and dividers — the outline of a flyout or dialog, and the
   hairline between list sections.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L254-L257 */
:root {
  --winui-surface-stroke-default: #75757566;
  --winui-surface-stroke-flyout: #0000000f;
  --winui-divider-stroke-default: #0000000f;
}

/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L50-L53 */
@media (prefers-color-scheme: dark) {
  :root {
    --winui-surface-stroke-default: #75757566;
    --winui-surface-stroke-flyout: #00000033;
    --winui-divider-stroke-default: #ffffff15;
  }
}

/* Text fills. Inverse is the one that flips: it is the fill for text sitting on
   a surface from the opposite theme, so it carries the other dictionary's
   primary.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L209-L213 */
:root {
  --winui-text-fill-primary: #000000e4;
  --winui-text-fill-secondary: #0000009e;
  --winui-text-fill-tertiary: #00000072;
  --winui-text-fill-disabled: #0000005c;
  --winui-text-fill-inverse: #ffffff;
}

/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L5-L9 */
@media (prefers-color-scheme: dark) {
  :root {
    --winui-text-fill-primary: #ffffff;
    --winui-text-fill-secondary: #ffffffc5;
    --winui-text-fill-tertiary: #ffffff87;
    --winui-text-fill-disabled: #ffffff5d;
    --winui-text-fill-inverse: #000000e4;
  }
}

/* The description line's own step. SystemControlDescriptionTextForegroundBrush
   is not part of the modern ramp above -- it comes from the legacy system-brush
   layer and carries SystemBaseMediumColor, black or white at 60%, distinct from
   the 62% and 77% the secondary text fill carries, so it is not folded onto a
   neighbour.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/themes/generic.xaml#L321-L327
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/themes/generic.xaml#L4134 */
:root {
  --winui-text-base-medium: #00000099;
}

/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/themes/generic.xaml#L209 */
@media (prefers-color-scheme: dark) {
  :root {
    --winui-text-base-medium: #ffffff99;
  }
}

/* The accent. The dictionaries state the relationship between the fills — one
   base at 1.0, 0.9 and 0.8 opacity — and which step of the ramp that base is:
   light keys off Dark1 and dark off Light2, walking the ramp in opposite
   directions so the accent stays legible against each theme's material.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L125-L127
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L329-L331

   The ramp itself is in no dictionary and cannot be: Windows generates its seven
   steps per machine from the accent the user picked, and a browser cannot read
   them. The values below are the ramp Windows 11 generates for its own default,
   #0078D4 -- the one assumption in this file, since a user who picked a
   different accent sees Windows' default blue rather than theirs. The generation
   algorithm changed between Windows 10 and 11; these are the 11 ones.
   https://valer100.github.io/winaccent/colors/accent-color-and-shades/
   https://learn.microsoft.com/en-us/uwp/api/windows.ui.viewmanagement.uicolortype */
:root {
  --winui-system-accent-light-3: #99ebff;
  --winui-system-accent-light-2: #4cc2ff;
  --winui-system-accent: #0078d4;
  --winui-system-accent-dark-1: #0067c0;
  --winui-system-accent-dark-2: #003e92;
  --winui-system-accent-dark-3: #001a68;
  --winui-accent-base: var(--winui-system-accent-dark-1);
  --winui-accent-fill-default: var(--winui-accent-base);
  --winui-accent-fill-secondary: color-mix(in srgb, var(--winui-accent-base) 90%, transparent);
  --winui-accent-fill-tertiary: color-mix(in srgb, var(--winui-accent-base) 80%, transparent);
  --winui-accent-text-fill-primary: var(--winui-system-accent-dark-2);
  --winui-accent-text-fill-secondary: var(--winui-system-accent-dark-3);
  --winui-accent-text-fill-tertiary: var(--winui-system-accent-dark-1);
}

@media (prefers-color-scheme: dark) {
  :root {
    --winui-accent-base: var(--winui-system-accent-light-2);
    --winui-accent-text-fill-primary: var(--winui-system-accent-light-3);
    --winui-accent-text-fill-secondary: var(--winui-system-accent-light-3);
    --winui-accent-text-fill-tertiary: var(--winui-system-accent-light-2);
  }
}

/* The selection highlight behind selected text. Both dictionaries key it to
   SystemAccentColor unmodified — not a step of the Dark1/Light2 ramp the accent
   fills use — so it is the one accent surface that does not flip with the
   theme, and the ramp above states that step, so it is taken literally.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L124
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L328 */
:root {
  --winui-accent-fill-selected-text-background: var(--winui-system-accent);
}

/* The disabled accent fill is a literal rather than a step of that ramp.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L242 */
:root {
  --winui-accent-fill-disabled: #00000037;
}

/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L38 */
@media (prefers-color-scheme: dark) {
  :root {
    --winui-accent-fill-disabled: #ffffff28;
  }
}

/* Text on and against accent. The light dictionary's disabled step is opaque
   white rather than a wash, so every disabled accent surface renders its label
   at about 1.7:1 there against AccentFillColorDisabled. That is WinUI's own
   result -- measured off Microsoft's screenshots on the issue below, which
   they closed as not planned -- so it is transcribed, not corrected; raising it
   would be a departure of ours to own. Dark's #87ffffff reaches about 3.7:1.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L214-L218
   https://github.com/microsoft/microsoft-ui-xaml/issues/6500 */
:root {
  --winui-accent-text-fill-disabled: #0000005c;
  --winui-text-on-accent-fill-primary: #ffffff;
  --winui-text-on-accent-fill-secondary: #ffffffb3;
  --winui-text-on-accent-fill-disabled: #ffffff;
  --winui-text-on-accent-fill-selected-text: #ffffff;
}

/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L10-L14 */
@media (prefers-color-scheme: dark) {
  :root {
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
:root {
  --winui-control-corner-radius: 4px;
  --winui-overlay-corner-radius: 8px;
}

/* Control alt fills — the interior of a control whose body is a cavity rather
   than a surface. The ramp runs the opposite way to the control fills, so it
   darkens on light and lightens on dark, and the disabled step is fully
   transparent in both dictionaries rather than a faint wash.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L233-L237 */
:root {
  --winui-control-alt-fill-secondary: #00000006;
  --winui-control-alt-fill-tertiary: #0000000f;
  --winui-control-alt-fill-quarternary: #00000018;
  --winui-control-alt-fill-disabled: #ffffff00;
}

/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L29-L33 */
@media (prefers-color-scheme: dark) {
  :root {
    --winui-control-alt-fill-secondary: #00000019;
    --winui-control-alt-fill-tertiary: #ffffff0b;
    --winui-control-alt-fill-quarternary: #ffffff12;
    --winui-control-alt-fill-disabled: #ffffff00;
  }
}

/* Focus strokes — an outer ring in the text color and an inner one in the
   surface color, so the ring stays visible on any fill including accent.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L258-L259 */
:root {
  --winui-focus-stroke-outer: #000000e4;
  --winui-focus-stroke-inner: #ffffffb3;
}

/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L54-L55 */
@media (prefers-color-scheme: dark) {
  :root {
    --winui-focus-stroke-outer: #ffffff;
    --winui-focus-stroke-inner: #000000b3;
  }
}

/* TextControlForegroundDisabled resolves to TemporaryTextFillColorDisabled, a
   near-neutral off by one channel step rather than TextFillColorDisabled's pure
   black or white, so a disabled input reads differently from other disabled text.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L129
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L141 */
:root {
  --winui-temporary-text-fill-disabled: #0101015c;
}

/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L22 */
@media (prefers-color-scheme: dark) {
  :root {
    --winui-temporary-text-fill-disabled: #fefefe5d;
  }
}

/* Status fills. Attention is a step of the accent ramp, and not the step the
   accent fills take — the unmodified accent in light, Light2 in dark.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L280-L291
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L369 */
:root {
  --winui-system-fill-success: #0f7b0f;
  --winui-system-fill-caution: #9d5d00;
  --winui-system-fill-critical: #c42b1c;
  --winui-system-fill-attention: var(--winui-system-accent);
  --winui-system-fill-success-background: #dff6dd;
  --winui-system-fill-caution-background: #fff4ce;
  --winui-system-fill-critical-background: #fde7e9;
  --winui-system-fill-attention-background: #f6f6f680;
}

/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L76-L87
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L165 */
@media (prefers-color-scheme: dark) {
  :root {
    --winui-system-fill-success: #6ccb5f;
    --winui-system-fill-caution: #fce100;
    --winui-system-fill-critical: #ff99a4;
    --winui-system-fill-attention: var(--winui-system-accent-light-2);
    --winui-system-fill-success-background: #393d1b;
    --winui-system-fill-caution-background: #433519;
    --winui-system-fill-critical-background: #442726;
    --winui-system-fill-attention-background: #ffffff08;
  }
}

/* Composed strokes. WinUI outlines a control with a LinearGradientBrush over an
   absolute 3px span, transcribed here as a border-color shorthand whose terms
   are the top, the sides and the bottom. A border-box linear-gradient behind a
   transparent border would reproduce the brush exactly, fade band included; it
   would also claim the border-box background layer of every control taking the
   stroke and stop the stroke being a token the dark block can re-point.

   CircleElevationBorderBrush, the third brush of the family, is not emitted:
   its only user, the toggle switch's on knob, binds it without ever stating a
   BorderThickness, so shipped WinUI paints no such outline.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleSwitch_themeresources.xaml#L159
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleSwitch_themeresources.xaml#L510 */

/* Light flips the gradient (ScaleY="-1"), putting the heavier
   ControlStrokeColorSecondary edge at the bottom.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L382-L390 */
:root {
  --winui-control-elevation-border-color:
    var(--winui-control-stroke-default)
    var(--winui-control-stroke-default)
    var(--winui-control-stroke-secondary);
}

/* Dark leaves the gradient unflipped, so the brighter edge sits at the top.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L186-L191 */
@media (prefers-color-scheme: dark) {
  :root {
    --winui-control-elevation-border-color:
      var(--winui-control-stroke-secondary)
      var(--winui-control-stroke-default)
      var(--winui-control-stroke-default);
  }
}

/* The accent outline is the same construction over the on-accent strokes, and
   is likewise flipped in both dictionaries.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L198-L206
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L397-L405 */
:root {
  --winui-accent-control-elevation-border-color:
    var(--winui-control-stroke-on-accent-default)
    var(--winui-control-stroke-on-accent-default)
    var(--winui-control-stroke-on-accent-secondary);
}

/* Motion. The values are declared in ./motion.ts, because the presence
   animations and the measured indicators need them as numbers. */
:root {
  --winui-control-normal-animation-duration: ${CONTROL_NORMAL_ANIMATION_MS}ms;
  --winui-control-fast-animation-duration: ${CONTROL_FAST_ANIMATION_MS}ms;
  --winui-control-faster-animation-duration: ${CONTROL_FASTER_ANIMATION_MS}ms;
  --winui-control-fast-out-slow-in-easing: ${CONTROL_FAST_OUT_SLOW_IN_EASING};
  --winui-expand-animation-duration: ${EXPAND_ANIMATION_MS}ms;
  --winui-collapse-animation-duration: ${COLLAPSE_ANIMATION_MS}ms;
  --winui-reposition-animation-duration: ${REPOSITION_ANIMATION_MS}ms;
  --winui-reposition-easing: ${REPOSITION_EASING};
  --winui-page-leave-duration: ${PAGE_LEAVE_MS}ms;
  --winui-page-leave-easing: ${PAGE_LEAVE_EASING};
  --winui-page-enter-duration: ${PAGE_ENTER_MS}ms;
  --winui-page-enter-easing: ${PAGE_ENTER_EASING};
  --winui-page-enter-offset: ${PAGE_ENTER_OFFSET_PX}px;
}

/* Button padding. XAML thicknesses read left,top,right,bottom while the CSS
   shorthand reads top,right,bottom,left; the two horizontal values are equal
   here, so this collapses to three terms.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L152 */
:root {
  --winui-button-padding: 5px 11px 6px;
}

/* ComboBoxThemeMinWidth, which WinUI puts on the template's Background border so
   the field keeps a body no matter how short the selected value is. Spent by
   ../components/ui/fluent-form-controls.tsx, where it is the floor a select
   falls back to.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L321
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L571 */
:root {
  --winui-combo-box-min-width: 64px;
}

/* Not emitted. One metric the controls above ask for is deliberately left on
   Fluent's own value.

   TextControlThemePadding is 10,5,6,6, stated in the controls dictionary
   alongside a 1px border, both overriding the framework's legacy generic.xaml.
   Its vertical half is absorbed here by the control's derived height, because
   Fluent centres the content rather than padding it; its horizontal half is left
   on the 12px spacingHorizontalM that Fluent's input slot already carries. The
   height the pair determines is derived at the rule that spends it in
   ./controls/text-input.css.ts, where one shared row height is taken instead.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources.xaml#L10-L12
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/themes/generic.xaml#L173-L175
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L192-L194
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L337-L338

   Type and spacing stay Fluent's, for two different reasons. WinUI's shared type
   ramp gives font size and weight only and leaves leading to
   LineStackingStrategy, which has no CSS counterpart, so Fluent's matched
   size/line-height pairs are spent instead; at the size in use the two agree.
   Spacing has no shared ramp to lift: WinUI states each step as a per-control
   thickness, of which ButtonPadding above is one, so a step no control declares
   takes a Fluent spacing token.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBlock_themeresources.xaml#L3-L9
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBlock_themeresources.xaml#L10-L51 */
`;
