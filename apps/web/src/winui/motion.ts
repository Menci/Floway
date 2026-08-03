// The WinUI 3 motion vocabulary, as values: a Web Animations keyframe takes a
// number and will not resolve a `var()`, so the numbers live here and
// ./tokens.ts interpolates them into custom properties for the CSS form.

// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L602-L606
export const CONTROL_NORMAL_ANIMATION_MS = 250;
export const CONTROL_FAST_ANIMATION_MS = 167;
export const CONTROL_FASTER_ANIMATION_MS = 83;
export const CONTROL_FAST_OUT_SLOW_IN_EASING = 'cubic-bezier(0, 0, 0, 1)';

// SplitView's overlaying pane, which is the pane NavigationView opens over its
// content. Its transition translates the pane and the pane's clip, with no
// opacity and no shadow key frame riding along, and it leaves faster than it
// arrives on the one spline both directions share.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/SplitView/SplitView_themeresources.xaml#L63-L70
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/SplitView/SplitView_themeresources.xaml#L185-L190
export const PANE_SLIDE_MS = 350;
export const PANE_SLIDE_OUT_MS = 120;
export const PANE_SLIDE_EASING = 'cubic-bezier(0.1, 0.9, 0.2, 1)';

// Expander's own open and close, which are neither the control durations above
// nor symmetric with each other.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander.xaml#L33-L90
export const EXPAND_ANIMATION_MS = 333;
export const COLLAPSE_ANIMATION_MS = 167;

// The expand chevron of Expander and of NavigationViewItem is one and the same
// AnimatedIcon, so both turn on the timing baked into its generated visual
// source: a 260-frame composition lasting c_durationTicks of 100ns, in which
// the segments that turn -- NormalOffToNormalOn and NormalOnToNormalOff --
// each spend ten frames rotating, on the one spline they share.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L280-L282
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L617-L619
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/AnimatedIcon/AnimatedVisuals/AnimatedChevronUpDownSmallVisualSource.cpp#L104
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/AnimatedIcon/AnimatedVisuals/AnimatedChevronUpDownSmallVisualSource.cpp#L350-L353
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/AnimatedIcon/AnimatedVisuals/AnimatedChevronUpDownSmallVisualSource.cpp#L423-L440
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/AnimatedIcon/AnimatedVisuals/AnimatedChevronUpDownSmallVisualSource.cpp#L781
const CHEVRON_VISUAL_MS = 43333333 / 10000;
const CHEVRON_VISUAL_FRAMES = 260;
const CHEVRON_TURN_FRAMES = 10;

export const CHEVRON_TURN_MS = Math.round((CHEVRON_VISUAL_MS * CHEVRON_TURN_FRAMES) / CHEVRON_VISUAL_FRAMES);
export const CHEVRON_TURN_EASING = 'cubic-bezier(0.167, 0.167, 0, 1)';

// RepositionThemeAnimation. Its timing lives in the PVL table of the OS visual
// style (TAS_REPOSITION / TA_REPOSITION_TARGET) and appears in no source file;
// these are decoded from aero.msstyles, byte-identical across the Windows 8.1,
// 10 21H2 and 11 styles, and corroborated by WinJS and by
// SwipeHintThemeAnimation, which cannot reach PVL and hardcodes them.
// https://github.com/winjs/winjs/blob/b9e0b33f76c57caac941c9b1885bf69443320b1c/src/js/WinJS/Animations.js#L349-L367
// https://github.com/microsoft/microsoft-ui-xaml/blob/543310634592831f8f2638301ece05d2d2dbea39/src/dxaml/xcp/dxaml/lib/SwipeHintThemeAnimation_Partial.h#L18-L32
export const REPOSITION_ANIMATION_MS = 367;
export const REPOSITION_EASING = 'cubic-bezier(0.1, 0.9, 0.2, 1)';

// The delay a list charges its survivors when something leaves it, so the
// departing item gets a head start before the gap closes. WinJS writes it as a
// condition on the deleted set, so an arrival, which perturbs the same
// survivors, pays nothing -- which is the whole rule, not just the number.
//
// Spliced: we take the delay from that animation and not its durations. Its
// survivors travel for 400ms and its leavers shrink on a bezier of their own,
// where ours reposition on TAS_REPOSITION above and leave on POPUP_HIDE_MS
// below.
// https://github.com/winjs/winjs/blob/b9e0b33f76c57caac941c9b1885bf69443320b1c/src/js/WinJS/Animations.js#L447-L456
export const REPOSITION_DELETE_DELAY_MS = 60;

// PopInThemeAnimation and PopOutThemeAnimation, the transition XAML gives a
// surface that floats free of any edge -- a Flyout, and here a toast. Their
// timing lives in the PVL table (TAS_SHOWPOPUP / TAS_HIDEPOPUP) on the same
// route REPOSITION_ANIMATION_MS above documents, and WinJS is the corroborating
// transcription: showPopup travels on one spline while a much shorter opacity
// leg, delayed by its own duration, catches up.
//
// The exit carries no transform. PopOutThemeAnimation pins both its start and
// its destination offset to the origin, makes no call to read either back, and
// exposes no offset property at all; hidePopup is correspondingly a single
// opacity object rather than the array showPopup passes, and its signature takes
// no offset.
//
// The offset is the platform's own knob rather than a derived extent: PopIn
// reads FromHorizontalOffset and FromVerticalOffset and feeds them in as the
// start point, and the defaults make an unset PopIn a purely horizontal 40px
// travel -- FromHorizontalOffset is answered from a named constant, while
// FromVerticalOffset appears nowhere in that switch and falls through to the
// Double default of zero. The omission is deliberate: the same switch answers
// the vertical of PopupThemeTransition with 40 and of EntranceThemeTransition
// with 28.
// https://github.com/winjs/winjs/blob/b9e0b33f76c57caac941c9b1885bf69443320b1c/src/js/WinJS/Animations.js#L1164-L1181
// https://github.com/winjs/winjs/blob/b9e0b33f76c57caac941c9b1885bf69443320b1c/src/js/WinJS/Animations.js#L1203-L1211
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/lib/ThemeAnimations.cpp#L101-L127
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/lib/ThemeAnimations.cpp#L129-L148
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/components/DependencyObject/DependencyProperty.cpp#L83
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/components/DependencyObject/DependencyProperty.cpp#L537-L539
export const POPUP_SLIDE_MS = 367;
export const POP_IN_OFFSET_PX = 40;
export const POPUP_FADE_MS = 83;
export const POPUP_FADE_DELAY_MS = 83;
export const POPUP_HIDE_MS = 83;

// Its own constant despite matching REPOSITION_EASING and PAGE_ENTER_EASING, for
// the reason stated at the latter: separate declarations with separate owners.
export const POPUP_SLIDE_EASING = 'cubic-bezier(0.1, 0.9, 0.2, 1)';

// Selection indicator timing, shared by every control that has one. Offset and
// scale run the full duration while the transform origin flips at the snap on a
// single-frame step, which is what keeps the indicator from overshooting.
// Composition attaches an easing to the keyframe it interpolates *into* where
// CSS attaches it to the keyframe it interpolates *from*, so both curves sit one
// keyframe earlier at their use than they read in the source.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView.cpp#L2176-L2233
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView.cpp#L1990-L1993
export const INDICATOR_DURATION_MS = 600;
export const INDICATOR_POSITION_SNAP = 0.333;
export const INDICATOR_STRETCH_EASING = 'cubic-bezier(0.9, 0.1, 1, 0.2)';
export const INDICATOR_SETTLE_EASING = 'cubic-bezier(0.1, 0.9, 0.2, 1)';

// EntranceNavigationTransitionInfo. Strictly sequential rather than a
// cross-fade: the outgoing frame fades over PAGE_LEAVE_MS and the incoming frame
// is held at zero for exactly that long, then appears whole on a pair of
// DISCRETE opacity key frames, so only its travel animates. PAGE_ENTER_EASING
// stays its own constant despite matching REPOSITION_EASING, because they are
// separate declarations with separate owners.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/phone/lib/ThemeTransitions.cpp#L3179-L3186
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/phone/lib/ThemeTransitions.cpp#L3194-L3206
export const PAGE_LEAVE_MS = 150;
export const PAGE_ENTER_MS = 300;
export const PAGE_ENTER_OFFSET_PX = 140;
export const PAGE_LEAVE_EASING = 'cubic-bezier(0.7, 0, 1, 0.5)';
export const PAGE_ENTER_EASING = 'cubic-bezier(0.1, 0.9, 0.2, 1)';
