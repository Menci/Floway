// WinUI holds one thumb colour -- ControlStrongFillColorDefaultBrush -- across
// every state and moves the geometry instead, where OverlayScrollbars walks
// three opacities at a fixed width.
//
// The handle element stands for the thumb's *fill*, not its box: WinUI's thumb
// is a Rectangle stroked with a transparent 6px ScrollBarThumbStrokeThickness,
// and a XAML shape shrinks the geometry so the stroke lands inside the layout
// box, so every thumb measure reaches the handle as itself less 6 --
// ScrollBarSize 12 as the 6px expanded pill, ScrollBarVerticalThumbMinWidth 8 as
// the 2px hairline, ScrollBarVerticalThumbMinHeight 30 as the 24px floor. Both
// pills keep their outer edge 3px inside the rail, the contracted one pushed
// back out by ScrollBarThumbOffset 2.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/core/core/elements/shape.cpp#L861-L870
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/core/core/elements/framework.cpp#L2211-L2214
//
// The expanded track takes the acrylic in-app fill WinUI names for it, through
// the flat FallbackColor that brush declares -- the same substitution every
// other acrylic surface in this layer makes.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Materials/Acrylic/AcrylicBrush_themeresources.xaml#L96
//
// WinUI's increase and decrease buttons are deliberately dropped.
// OverlayScrollbars renders a track and a handle and no button parts, and a
// chevron synthesized on the rail would answer no click, so the strip would
// grow two affordances that do nothing.
//
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ScrollBar_themeresources.xaml#L26-L30
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ScrollBar_themeresources.xaml#L37-L38
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ScrollBar_themeresources.xaml#L177
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ScrollBar_themeresources.xaml#L180-L185
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ScrollBar_themeresources.xaml#L190
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ScrollBar_themeresources.xaml#L394-L395
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ScrollBar_themeresources.xaml#L399-L406
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ScrollBar_themeresources.xaml#L484
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ScrollBar_themeresources.xaml#L559-L560
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ScrollBar_themeresources.xaml#L571-L572
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ScrollBar_themeresources.xaml#L587
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ScrollBar_themeresources.xaml#L705-L708

import { reducedMotion } from './selectors';

const host = `.floway-scroll-area[data-overlayscrollbars='host']`;

export const scrollbarCss = `
/* ScrollBarSize is the rail; ScrollBarVerticalThumbMinHeight reaches the pill
   as 24 by the stroke arithmetic above. */
${host} .os-scrollbar {
  --os-size: 12px;
  --os-handle-border-radius: 3px;
  --os-handle-min-size: 24px;
  --os-handle-bg: var(--winui-control-strong-fill-default);
  --os-handle-bg-hover: var(--winui-control-strong-fill-default);
  --os-handle-bg-active: var(--winui-control-strong-fill-default);
}

/* ScrollBarExpandDuration and ScrollBarContractDuration are both the fast
   duration this layer already carries. The delays are the point of the effect --
   without them a pointer crossing the content edge on its way somewhere else
   pumps every scrollbar it passes -- and each belongs to whichever rule is
   becoming active, so expansion carries the 400 and rest the 500.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ScrollBar_themeresources.xaml#L173-L189
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ScrollBar_themeresources.xaml#L528-L601 */
${host} .os-scrollbar-vertical .os-scrollbar-handle {
  width: 6px;
  inset-inline-end: 3px;
  transition-property: width;
  transition-duration: var(--winui-control-fast-animation-duration);
  transition-timing-function: var(--winui-control-fast-out-slow-in-easing);
  transition-delay: 400ms;
}

${host} .os-scrollbar-horizontal .os-scrollbar-handle {
  height: 6px;
  inset-block-end: 3px;
  transition-property: height;
  transition-duration: var(--winui-control-fast-animation-duration);
  transition-timing-function: var(--winui-control-fast-out-slow-in-easing);
  transition-delay: 400ms;
}

${host} .os-scrollbar-vertical:not(:hover) .os-scrollbar-handle {
  width: 2px;
  transition-delay: 500ms;
}

${host} .os-scrollbar-horizontal:not(:hover) .os-scrollbar-handle {
  height: 2px;
  transition-delay: 500ms;
}

/* The track waits out the same delays as the thumb, as WinUI begins its opacity
   at ScrollBarExpandBeginTime and ScrollBarContractBeginTime: a channel
   appearing while the pill was still waiting would defeat the delay for half the
   control. */
${host} .os-scrollbar .os-scrollbar-track {
  transition-property: background-color;
  transition-duration: var(--winui-control-faster-animation-duration);
  transition-delay: 500ms;
}

${host} .os-scrollbar:hover .os-scrollbar-track {
  background-color: var(--winui-acrylic-in-app-fill-default);
  transition-delay: 400ms;
}

/* Forced colours keep a background-color's alpha but take its channels from the
   palette, so the thumb would otherwise wash out to a half-transparent Canvas
   over the content it sits on, and the track with it.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ScrollBar_themeresources.xaml#L87
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ScrollBar_themeresources.xaml#L93-L94
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/themes/generic.xaml#L2047
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/themes/generic.xaml#L2093
   https://drafts.csswg.org/css-color-adjust/#forced-colors-properties */
@media (forced-colors: active) {
  ${host} .os-scrollbar .os-scrollbar-handle {
    background-color: ButtonText;
  }

  ${host} .os-scrollbar:hover .os-scrollbar-track {
    background-color: Canvas;
  }
}

/* Suppressed in both directions, one more than WinUI, whose single
   VisualTransition gates only the contract: matching it would leave a bar that
   grows smoothly and vanishes instantly. The delays stay -- they are timing
   rather than travel.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ScrollBar_themeresources.xaml#L530-L555 */
${reducedMotion([
  `${host} .os-scrollbar .os-scrollbar-handle`,
  `${host} .os-scrollbar .os-scrollbar-track`,
], 'transition-duration')}
`;
