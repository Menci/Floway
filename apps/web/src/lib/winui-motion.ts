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
// one keyframe earlier here than they read in the source.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView.cpp#L2176-L2233
export const DURATION_MS = 600;
export const POSITION_SNAP = 0.333;
export const REACH_MS = Math.round(DURATION_MS * POSITION_SNAP);
export const SETTLE_MS = DURATION_MS - REACH_MS;
export const STRETCH_EASING = 'cubic-bezier(0.9, 0.1, 1, 0.2)';
export const SETTLE_EASING = 'cubic-bezier(0.1, 0.9, 0.2, 1)';
export const STEP_AT_SNAP = 'steps(1, end)';
