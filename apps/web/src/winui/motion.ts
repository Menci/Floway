// The WinUI 3 motion vocabulary, as values.
//
// A Web Animations keyframe takes a number and will not resolve a `var()`, so
// the numbers live here and ./tokens.ts interpolates them into custom
// properties; that is what keeps the CSS and script forms one value. The
// indicator group is stated in no CSS rule and so is not published.

// WinUI states a duration as a XAML timespan and an easing as a KeySpline,
// whose four numbers are exactly the two control points of a CSS cubic-bezier.
// These sit outside the theme dictionaries and so do not vary by theme.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L602-L606
export const CONTROL_NORMAL_ANIMATION_MS = 250;
export const CONTROL_FAST_ANIMATION_MS = 167;
export const CONTROL_FASTER_ANIMATION_MS = 83;
export const CONTROL_FAST_OUT_SLOW_IN_EASING = 'cubic-bezier(0, 0, 0, 1)';

// Expander's own open and close, which are neither the control durations above
// nor symmetric with each other. WinUI's closing spline is not transcribed; the
// rule that departs says why.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander.xaml#L33-L90
export const EXPAND_ANIMATION_MS = 333;
export const COLLAPSE_ANIMATION_MS = 167;

// RepositionThemeAnimation. A XAML template invokes it by name and states no
// timing, because the timing lives in the PVL table of the OS visual style
// (TAS_REPOSITION / TA_REPOSITION_TARGET) and appears in no source file. These
// numbers are decoded from aero.msstyles -- Translate2D over 367ms on
// cubic-bezier(0.1, 0.9, 0.2, 1), byte-identical across the Windows 8.1, 10
// 21H2 and 11 styles -- and corroborated by WinJS, which drives the same
// animation library through CSS, and by SwipeHintThemeAnimation, which cannot
// reach PVL and hardcodes the same control points.
// https://github.com/winjs/winjs/blob/b9e0b33f76c57caac941c9b1885bf69443320b1c/src/js/WinJS/Animations.js#L349-L367
// https://github.com/microsoft/microsoft-ui-xaml/blob/543310634592831f8f2638301ece05d2d2dbea39/src/dxaml/xcp/dxaml/lib/SwipeHintThemeAnimation_Partial.h#L18-L32
export const REPOSITION_ANIMATION_MS = 367;
export const REPOSITION_EASING = 'cubic-bezier(0.1, 0.9, 0.2, 1)';

// The timing WinUI moves a selection indicator with, shared by every control
// that has one. Offset and scale run 600ms while the transform origin runs
// 200ms -- the same instant as the 0.333 keyframe the other two share, which is
// why one snap moment describes all three. The origin flips there on a
// single-frame step, and that is what keeps the indicator from overshooting.
//
// Composition attaches an easing to the keyframe it interpolates *into*, where
// CSS attaches it to the keyframe it interpolates *from*, so the two curves sit
// one keyframe earlier at their use than they read in the source.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView.cpp#L2176-L2233
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView.cpp#L1990-L1993
export const INDICATOR_DURATION_MS = 600;
export const INDICATOR_POSITION_SNAP = 0.333;
export const INDICATOR_STRETCH_EASING = 'cubic-bezier(0.9, 0.1, 1, 0.2)';
export const INDICATOR_SETTLE_EASING = 'cubic-bezier(0.1, 0.9, 0.2, 1)';

// EntranceNavigationTransitionInfo -- what a frame plays when it navigates
// forward. The animation is strictly sequential rather than a cross-fade: the
// outgoing frame's opacity is splined to zero over the first 150 and the
// incoming frame is held at zero for exactly that long. The incoming frame does
// not fade in at all; its opacity is a pair of DISCRETE key frames, so it
// appears whole and the only thing that animates is the 140 it travels up.
//
// PAGE_ENTER_EASING is the same curve as REPOSITION_EASING above, arrived at
// independently. They stay separate constants because they are separate
// declarations with separate owners.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/phone/lib/ThemeTransitions.cpp#L3179-L3186
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/phone/lib/ThemeTransitions.cpp#L3194-L3206
export const PAGE_LEAVE_MS = 150;
export const PAGE_ENTER_MS = 300;
export const PAGE_ENTER_OFFSET_PX = 140;
export const PAGE_LEAVE_EASING = 'cubic-bezier(0.7, 0, 1, 0.5)';
export const PAGE_ENTER_EASING = 'cubic-bezier(0.1, 0.9, 0.2, 1)';
