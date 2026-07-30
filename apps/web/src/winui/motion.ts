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
