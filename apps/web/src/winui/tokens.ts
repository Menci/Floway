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
// block: the accent ramp, which Windows generates per machine from the user's
// chosen accent and which therefore appears in no dictionary, and the composed
// strokes, which restate a LinearGradientBrush as a per-side border colour, or
// as inset box-shadows where the outlined part has no border box.
//
// ---------------------------------------------------------------------------
// Selector convention for the whole WinUI override layer
// ---------------------------------------------------------------------------
//
// Every rule in `controls/` takes the form
//
//     .fui-X.fui-X { … }
//
// repeating the class of the element the rule is about — its subject, the
// rightmost compound of the selector. Context to the left of the subject stays
// single-classed and uses whatever combinator the relationship needs:
//
//     .fui-DialogActions.fui-DialogActions { … }          /* about DialogActions */
//     .fui-DialogActions > .fui-Button.fui-Button { … }   /* about the button in it */
//     .fui-MenuList .fui-MenuItem.fui-MenuItem { … }      /* about the item in a list */
//
// The doubling is a specificity device and nothing else, so it applies once, to
// the subject. That puts the subject at exactly one class above Griffel's
// single-class atoms — enough to win regardless of stylesheet order, and low
// enough that a consumer's own class can still override us.
//
// The rejected alternative was to scope each rule under an ancestor
// `.fui-FluentProvider`. It works today, and it works on portalled surfaces
// too, because a portal mount node created under document.body carries the
// provider root's full className:
//
//   useFluentProviderStyles.styles.js:30
//     state.root.className = mergeClasses(fluentProviderClassNames.root, state.themeClassName, …)
//   useFluentProvider.js:28
//     const { applyStylesToPortals = true, … }
//   useFluentProviderContextValues.js:31
//     themeClassName: applyStylesToPortals ? root.className : themeClassName
//   usePortalMountNode.js:201
//     className: mergeClasses(themeClassName, classes.root, options.className)
//
// That reach is conditional: it survives only while `applyStylesToPortals`
// keeps its default. The prop belongs to Fluent's API and any consumer may set
// it to false, at which point a mount node keeps the theme class alone and
// every ancestor-scoped rule silently stops applying to dialogs, popovers,
// menus and tooltips. We do not want the layer resting on a prop we do not own.
//
// The self-doubled form also reads better. A nested FluentProvider — a themed
// subtree, a preview pane — adds another ancestor that matches, so the ancestor
// form gains a second matching path and no new meaning, while the doubled form
// is unaffected either way. And when a rule genuinely needs a combinator, the
// ancestor form leaves two prefixes in front of the subject and pushes the
// subject's own weight to three classes for no reason; the doubled form keeps
// the selector's leftmost compound meaningful, so a reader can tell which
// element a rule paints by looking at its end.
//
// A `[class*='fui-FluentProvider']` ancestor prefix would repair the reach,
// since it also matches the bare theme class, but it buys that back at the
// price of a substring match in front of every rule in the layer, for a
// specificity floor the doubled subject already provides.
//
// Two kinds of subject cannot take that form, and both are deliberate. A rule
// about an element Fluent does not render — the OverlayScrollbars parts, and
// the `.floway-*` elements our own wrappers add — has no `fui-` class to
// double, so it names the class it has and doubles nothing; those elements
// carry no Griffel atoms either, so there is no specificity to beat. A rule
// about an unclassed descendant of a Fluent element — a slot Fluent renders as
// a bare child — keeps the doubled Fluent subject in front of it and reaches
// the child with a combinator.
//
// ---------------------------------------------------------------------------
// Opting a subtree out of the restyle
// ---------------------------------------------------------------------------
//
// `data-winui-card-restyle='off'` on an element removes the layer from it and
// everything below. Surfaces designed against Fluent's own palette and
// elevations live under it — the playground transcript and composer above all.
// Two mechanisms carry it, and which one a rule needs depends on what the rule
// spends. A rule that reads a `--winui-*` custom property goes through an
// indirection declared on `:root` and reset to `initial` under the attribute,
// with the Fluent value as the `var()` fallback; a rule that cannot be
// expressed as a value — geometry, a new declaration Fluent does not make —
// excludes the subtree in its selector with
// `:not([data-winui-card-restyle='off'] *)`.
//
// The attribute cannot reach a portalled surface: a tooltip, a dialog or a menu
// mounts under the provider root rather than under the element that opened it,
// so neither inheritance nor a descendant selector connects the two. Anything
// the layer restyles on a portalled surface therefore reaches every instance of
// it in the app, and a portalled surface that must not be restyled cannot be
// restyled at all.
//
// The trade the doubled form accepts is that a rule matches a Fluent element
// anywhere in the document, including outside any provider. Fluent's classes
// are only ever emitted by Fluent's own components, so in practice that set and
// "everything under a provider" are the same elements.
//
// The `--winui-*` custom properties below follow from the same reasoning and
// are declared on `:root`, every one of them. They switch on
// `prefers-color-scheme`, never on the provider's `theme` prop, so the provider
// element is not the scope they belong to; the document root is the widest one
// there is, and inherits into every node — mount nodes included, under either
// setting of the prop. No value here reads a Fluent theme variable, so nothing
// forces a narrower scope: the layer's vocabulary is independent of where
// Fluent chooses to declare its theme.

import { CONTROL_FASTER_ANIMATION_MS, CONTROL_FAST_ANIMATION_MS, CONTROL_FAST_OUT_SLOW_IN_EASING, CONTROL_NORMAL_ANIMATION_MS, REPOSITION_ANIMATION_MS, REPOSITION_EASING } from './motion';

// The selector half of the opt-out documented above: appended to a rule's
// subject compound, it stops the rule at the boundary of an opted-out subtree.
// Rules that spend a token instead go through a `:root` indirection reset to
// `initial` there, and need nothing from here.
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

/* The control strong fill — the scroll bar thumb, and the panning indicator we
   have no counterpart for. It sits in the fill block of the dictionaries rather
   than with the strokes above, so it carries its own permalinks.
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

/* Subtle fills — the hover and pressed wash on otherwise chromeless surfaces
   such as list rows and transparent buttons.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L229-L231 */
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

/* Card and layer fills — translucent surfaces that sit on the solid background
   ramp rather than replacing it.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L250-L265 */
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

/* The in-app acrylic material, as the flat colour it declares for itself when
   acrylic is unavailable. Every AcrylicBrush carries a FallbackColor for
   exactly that case, and the web is that case: there is no backdrop material
   here to tint. So a flyout that XAML fills with AcrylicInAppFillColorDefault
   takes this rather than staying Fluent's flat white.
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

/* The drop shadow under a tooltip, which is the one overlay whose depth WinUI
   states in code rather than in a dictionary. ToolTip applies
   ApplyElevationEffect(presenter, 0, 16) under IsDropShadowMode(), which
   returns true unconditionally in WinUI 3, so 16 is the live elevation where a
   flyout's is the 32 of s_elevationBaseDepth.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/lib/ToolTip_Partial.cpp#L634-L653
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/components/graphics/ThemeShadow.cpp#L221-L228
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/lib/ElevationHelper.cpp#L19-L21

   The recipe turns that elevation into the shadow itself: Elevation is
   min(64, 16/2) = 8, which falls inside the 2..16 band where the ambient term
   is zero, leaving one directional shadow of blur 8, Y offset Elevation * 0.5
   = 4 and opacity min(8/100 + 0.06, 0.14) in light against a flat 0.26 in
   dark, truncated to a byte as 0x23 and 0x42 over pure black. The compositor
   is handed the blur radius plus one, so the geometry the rule writes is
   0 4px 9px.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/components/graphics/inc/DropShadowRecipe.h#L108-L162
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/components/comptree/HWCompNodeWinRT.cpp#L1675

   Sourced, but not from a dictionary, and it carries one assumption: that
   CompositionDropShadow's BlurRadius and the CSS blur radius describe the same
   Gaussian. Nothing in that corpus states the equivalence, so the colour and
   the offset are transcribed and the blur is that assumption. */
:root {
  --winui-tooltip-shadow-color: #00000023;
}

@media (prefers-color-scheme: dark) {
  :root {
    --winui-tooltip-shadow-color: #00000042;
  }
}

/* Solid backgrounds — the opaque ramp everything translucent is composited on.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L272-L279 */
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

/* Text fills — the foreground ramp WinUI paints on any neutral surface.
   Inverse is the one that flips: it is the fill for text sitting on a surface
   from the opposite theme, so it carries the other dictionary's primary.
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

/* The accent. The dictionaries state the relationship between the fills — one
   base at 1.0, 0.9 and 0.8 opacity — and which step of the ramp that base is:
   light keys off Dark1 and dark off Light2, walking the ramp in opposite
   directions so the accent stays legible against each theme's material.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L125-L127
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L329-L331

   The ramp itself is not in any dictionary, and cannot be: Windows generates
   its seven steps per machine from the accent the user picked, and hands them
   to XAML as SystemAccentColor with Light1-3 and Dark1-3. A browser cannot read
   them. The values below are the ramp Windows 11 generates for its own default,
   #0078D4, which is the one assumption in this file -- a user who picked a
   different accent sees Floway in Windows' default blue rather than in theirs.

   They are sourced from the Windows runtime rather than from a theme
   dictionary, and cross-checked two ways: winaccent documents the generated
   ramp for that default, and states independently that dark-mode UI takes
   accent_light_2 while light-mode takes accent_dark_1 -- which is what
   AccentFillColorDefaultBrush resolves to in each theme dictionary here. The
   generation algorithm changed between Windows 10 and 11; these are the 11 ones.
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

/* Text on and against accent.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L214-L218 */
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
   than a surface: the unchecked check box and radio button, and the off track
   of a toggle switch. The ramp runs the opposite way to the control fills, so
   it darkens on light and lightens on dark, and the disabled step is fully
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

/* Focus strokes. WinUI draws focus as two concentric rings, an outer one in the
   text color and an inner one in the surface color, so the visual survives on
   any fill including accent. Both flip with the theme.
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

/* Disabled text inside a text control. TextControlForegroundDisabled resolves
   to TemporaryTextFillColorDisabled, which is a near-neutral off by one step
   from black and white rather than TextFillColorDisabled's pure channel, so a
   disabled input reads slightly differently from other disabled text.
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

/* Status fills — the colour of a validation or severity glyph, and the wash a
   severity puts behind a whole bar. These are the only opaque hues in the
   vocabulary besides the background ramp, and the two dictionaries carry
   genuinely different hues rather than one hue at two opacities, because each
   is tuned for contrast against its own background.

   Attention is the exception: it is a step of the accent ramp rather than a
   literal, and not the same step the accent fills take — the unmodified accent
   in light, Light2 in dark.
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

/* Composed strokes. WinUI outlines a control with a LinearGradientBrush mapped
   in absolute units — a 3px span for ControlElevationBorderBrush and
   AccentControlElevationBorderBrush — so one edge reads heavier than the other
   three regardless of how tall the control is. The web has no equivalent of an
   absolute-mapped brush used as a border, so each is transcribed as a
   border-color shorthand whose three terms are the top, the sides and the
   bottom.

   The circle stroke is the exception: it outlines a round part that has no
   border box of its own, so it is transcribed as a set of per-side 1px inset
   box-shadows, which follow border-radius. Painting each side separately rather
   than a full ring plus a heavier strip matters because box-shadow composites,
   and a translucent ring under a translucent strip would render the heavy edge
   darker than the XAML gradient ever gets. The two pixels where the heavy edge
   meets a side edge are covered by both insets, and a fully round part rounds
   them away. */

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

/* The circle stroke is a different construction from the three above: it maps
   relative to the bounding box rather than in absolute pixels, so its heavy
   edge is a proportion of the control rather than a fixed pixel, and its stops
   sit at 0.50 and 0.70 instead of 0.33 and 1.0. Neither dictionary flips it, so
   the heavy ControlStrokeColorSecondary edge is at the bottom in both themes
   and no dark override is needed. It outlines the toggle switch's knob; a
   checked radio dot takes the accent stroke instead.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L192-L197
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L391-L396 */
:root {
  --winui-circle-elevation-shadow:
    inset 0 1px 0 0 var(--winui-control-stroke-default),
    inset 1px 0 0 0 var(--winui-control-stroke-default),
    inset -1px 0 0 0 var(--winui-control-stroke-default),
    inset 0 -1px 0 0 var(--winui-control-stroke-secondary);
}

/* Motion. The values are declared in ./motion.ts, because the presence
   animations and the measured indicators need them as numbers, and a custom
   property is a string the Web Animations API will not resolve. */
:root {
  --winui-control-normal-animation-duration: ${CONTROL_NORMAL_ANIMATION_MS}ms;
  --winui-control-fast-animation-duration: ${CONTROL_FAST_ANIMATION_MS}ms;
  --winui-control-faster-animation-duration: ${CONTROL_FASTER_ANIMATION_MS}ms;
  --winui-control-fast-out-slow-in-easing: ${CONTROL_FAST_OUT_SLOW_IN_EASING};
  --winui-reposition-animation-duration: ${REPOSITION_ANIMATION_MS}ms;
  --winui-reposition-easing: ${REPOSITION_EASING};
}

/* Button padding. XAML thicknesses read left,top,right,bottom while the CSS
   shorthand reads top,right,bottom,left; the two horizontal values are equal
   here, so this collapses to three terms.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L152 */
:root {
  --winui-button-padding: 5px 11px 6px;
}

/* Unresolved. One family is asked for by the controls above and is not emitted,
   because there is no single element for it to land on.

   TextControlThemePadding is 10,3,6,6, and it is stated -- in the framework's
   own generic dictionary rather than in the control theme resources every other
   citation here points at. Fluent splits the inset it describes across two
   elements, the horizontal half on the field's root and the vertical handled by
   centring the content, so there is no element whose padding this thickness is.
   The metric beside it that does have a counterpart, the 32px floor, is
   transcribed at the rule that uses it in ./controls/text-input.css.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/themes/generic.xaml#L175
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L192-L194

   There is likewise no spacing or type scale to lift: WinUI states each metric
   as a per-control thickness or size, of which ButtonPadding above is one, and
   never as a shared ramp. Anything needing a step other than a metric a control
   actually declares uses Fluent's spacing and type tokens. */
`;
