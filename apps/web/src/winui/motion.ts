// The WinUI 3 motion vocabulary, as values.
//
// ./tokens.ts publishes the first group below as custom properties so a CSS
// rule can name a duration, and ./presence.ts and the measured indicators read
// them as numbers, because a Web Animations keyframe takes a number and a
// `var()` is a string the animation API will not resolve. Declaring them here
// and interpolating them there is what keeps the two forms one value.

// The durations and the easing every WinUI control shares. WinUI states a
// duration as a XAML timespan and an easing as a KeySpline, whose four numbers
// are exactly the two control points of a CSS cubic-bezier. Both sit outside
// the theme dictionaries and so do not vary by theme.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L602-L606
export const CONTROL_NORMAL_ANIMATION_MS = 250;
export const CONTROL_FAST_ANIMATION_MS = 167;
export const CONTROL_FASTER_ANIMATION_MS = 83;
export const CONTROL_FAST_OUT_SLOW_IN_EASING = 'cubic-bezier(0, 0, 0, 1)';

// Expander's own open and close, which are not the control durations above and
// are not symmetric. The content travels by its own height under a static clip,
// The close carries its own spline, cubic-bezier(1, 1, 0, 1), which is not
// transcribed and is not published here: it creeps for a third of its run and
// then snaps, because its time mapping is stationary at the midpoint. Under
// WinUI's fixed-height clip that is a flick of content; the consumer here
// animates a height, where it would jolt the page below, and says so at the
// rule that departs. Which end of the height it travels from depends on the expand
// direction, so the durations and splines are what carries over rather than the
// offsets: the four states in ExpandStates state the same 333 and 167 whichever
// way the content opens.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander.xaml#L33-L90
export const EXPAND_ANIMATION_MS = 333;
export const COLLAPSE_ANIMATION_MS = 167;

// RepositionThemeAnimation, the Windows animation library's move-an-element
// primitive. A XAML template invokes it by name and states no timing, because
// the timing is not the template's: it lives in the PVL table of the OS visual
// style under TAS_REPOSITION / TA_REPOSITION_TARGET and is read at runtime. The
// numbers appear in no source file, so they are transcribed from the shipped
// style itself -- aero.msstyles decodes to a Translate2D starting at 0ms over
// 367ms on cubic-bezier(0.1, 0.9, 0.2, 1), byte-identical in the Windows 8.1,
// Windows 10 21H2 and Windows 11 styles -- and corroborated twice over:
//
// WinJS drives the same animation library through CSS and writes the pair out
// in the clear.
// https://github.com/winjs/winjs/blob/b9e0b33f76c57caac941c9b1885bf69443320b1c/src/js/WinJS/Animations.js#L349-L367
//
// And SwipeHintThemeAnimation, which cannot reach PVL, hardcodes these same
// control points rather than invent its own, comment and all.
// https://github.com/microsoft/microsoft-ui-xaml/blob/543310634592831f8f2638301ece05d2d2dbea39/src/dxaml/xcp/dxaml/lib/SwipeHintThemeAnimation_Partial.h#L18-L32
//
// The table also carries a 33ms stagger capped at 250ms, which spaces the items
// of a list repositioning together and says nothing about a lone element.
export const REPOSITION_ANIMATION_MS = 367;
export const REPOSITION_EASING = 'cubic-bezier(0.1, 0.9, 0.2, 1)';

// The timing WinUI moves a selection indicator with, shared by every control
// that has one.
//
// Three animations run together over 600ms. The offset holds at the source and
// snaps to the destination a third of the way through; the scale stretches to
// span the distance by that same moment and settles back afterwards; and the
// transform origin flips at the snap, which is what keeps the indicator from
// overshooting -- anchored at the leading edge it grows out of what it is
// leaving, and anchored at the trailing edge it contracts into what it has
// reached.
//
// Composition attaches an easing to the keyframe it interpolates *into*, where
// CSS attaches it to the keyframe it interpolates *from*, so the two curves sit
// one keyframe earlier at their use than they read in the source.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView.cpp#L2176-L2233
export const INDICATOR_DURATION_MS = 600;
export const INDICATOR_POSITION_SNAP = 0.333;
export const INDICATOR_REACH_MS = Math.round(INDICATOR_DURATION_MS * INDICATOR_POSITION_SNAP);
export const INDICATOR_SETTLE_MS = INDICATOR_DURATION_MS - INDICATOR_REACH_MS;
export const INDICATOR_STRETCH_EASING = 'cubic-bezier(0.9, 0.1, 1, 0.2)';
export const INDICATOR_SETTLE_EASING = 'cubic-bezier(0.1, 0.9, 0.2, 1)';
