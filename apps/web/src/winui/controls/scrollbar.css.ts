// The scrollbar, restyled from OverlayScrollbars' defaults onto WinUI 3's.
//
// WinUI's scrollbar is conscious: at rest it is a bare hairline with no track
// behind it, and under the pointer it widens to a pill over a track. The two
// libraries disagree about what the pointer changes. OverlayScrollbars walks
// the handle through three opacities and leaves its width alone; WinUI holds
// one colour across rest, hover and press -- ScrollBarThumbFill, its PointerOver
// and its Pressed are all ControlStrongFillColorDefaultBrush -- and moves the
// geometry instead. Its conscious states name the thumb's fill twice more,
// ScrollBarPanningThumbBackground while collapsed and ScrollBarThumbBackground
// while expanded, and those are the same brush again, so the pill holds one
// colour through every state it has, in either theme.
//
// The handle element stands for the thumb's fill rather than for the thumb's
// box. The thumb is a Rectangle stroked with ScrollBarThumbBorderBrush, which
// is ControlFillColorTransparentBrush, at ScrollBarThumbStrokeThickness, and a
// XAML shape shrinks its geometry so that the stroke lands inside the layout
// box it was given. 6px of transparent stroke therefore ends the fill 3px
// inside every edge, and each thumb measure reaches the handle as itself less
// 6: the expanded thumb animates to ScrollBarSize, 12, and reads as a 6px pill;
// the contracted one returns to ScrollBarVerticalThumbMinWidth, 8, and reads as
// a 2px hairline; and the floor along the scroll axis,
// ScrollBarVerticalThumbMinHeight, 30, reads as 24. ScrollBarCornerRadius
// confirms the expanded reading -- a 3px radius is a full round-off only on a
// 6px pill.
//
// Both pills keep their outer edge 3px inside the rail, and WinUI arrives there
// from either state: the expanded thumb spans the 12px rail and gives the 3px
// back as stroke, while the contracted one is 8 wide, centred by the stretch
// alignment it inherits, and pushed outwards again by ScrollBarThumbOffset, 2,
// which puts its own stroked edge back on the rail edge. Only the width travels
// between the two.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/core/core/elements/shape.cpp#L861-L870
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/core/core/elements/framework.cpp#L2211-L2214
//
// The expanded track is AcrylicInAppFillColorDefaultBrush. That brush declares
// a flat FallbackColor for where acrylic cannot be composited, and ../tokens.ts
// carries it -- but the fallback is opaque, and a scrollbar track sits over the
// content it scrolls. The layer fill stands in instead: it is the declared
// resource closest in role, a translucent sheet meant to sit over content.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Materials/Acrylic/AcrylicBrush_themeresources.xaml#L96
//
// A bar with nothing left to scroll needs nothing said here. WinUI's thumb
// takes its Disabled state to zero opacity, and OverlayScrollbars marks that
// bar unusable, hides the handle outright and drops the whole control out of
// hit testing -- which leaves the track with no hover to answer either.
//
// Every rule here excludes the opted-out subtree in its selector rather than
// through a token indirection, because what it states is geometry Fluent never
// declares — see ../tokens.ts for both mechanisms.
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
import { notOptedOut } from '../tokens';

const host = `.floway-scroll-area[data-overlayscrollbars='host']${notOptedOut}`;

export const scrollbarCss = `
/* Rail geometry and thumb colour. ScrollBarSize is the rail; the minimum along
   the scroll axis is ScrollBarVerticalThumbMinHeight, and it reaches the pill
   as 24 because the pill is the thumb's fill and the stroke takes 3 off each
   end as well. */
${host} .os-scrollbar {
  --os-size: 12px;
  --os-handle-border-radius: 3px;
  --os-handle-min-size: 24px;
  --os-handle-bg: var(--winui-control-strong-fill-default);
  --os-handle-bg-hover: var(--winui-control-strong-fill-default);
  --os-handle-bg-active: var(--winui-control-strong-fill-default);
}

/* The thumb widens under the pointer, and the widening is a motion of its own:
   WinUI runs it over ScrollBarExpandDuration and ScrollBarContractDuration,
   both the same 167ms this layer already carries as its fast duration, on the
   fast-out-slow-in spline, and holds it off for 400ms on the way out and 500ms on the way back.
   The delays are the point of the effect -- without them a pointer crossing the
   edge of the content on its way somewhere else pumps every scrollbar it
   passes. The delay belongs to whichever rule is becoming active, so the
   expansion carries the 400 and the rest state carries the 500.

   Widening is all that travels. The pill's outer edge stays 3px inside the
   rail, which is where the thumb's stroke leaves it in both conscious states,
   so the growth is inwards, away from the content edge.
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

/* The track is drawn only while the scrollbar is expanded, which is what makes
   the rest state read as a hairline against the content rather than as a
   channel cut into it. It arrives on the fill's own duration, which is what
   WinUI gives the track and buttons either side of the thumb's travel, and it
   waits out the same delays: WinUI begins the track's opacity at
   ScrollBarExpandBeginTime and ScrollBarContractBeginTime, the same instants it
   begins the thumb's size. A channel that appeared while the pill was still
   waiting would defeat the delay for half the control. */
${host} .os-scrollbar .os-scrollbar-track {
  transition-property: background-color;
  transition-duration: var(--winui-control-faster-animation-duration);
  transition-delay: 500ms;
}

${host} .os-scrollbar:hover .os-scrollbar-track {
  background-color: var(--winui-layer-fill-default);
  transition-delay: 400ms;
}

/* High Contrast, where WinUI states the bar again: the thumb on ButtonText
   through both conscious states, the expanded track on the Window colour.
   Neither survives on its own -- forced colours keep a background-color's alpha
   but take its channels from the palette, so the thumb would otherwise wash out
   to a half-transparent Canvas over the content it sits on, and the track with
   it. The rest track needs no answer: it is fully transparent, and that is
   preserved.

   A media query carries no specificity, so each rule repeats the selector it
   answers.
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

/* The thumb changes size, which is motion rather than a state colour, so it
   goes when the OS says motion goes -- in both directions, which is one more
   than WinUI. Its dictionary holds a single VisualTransition, Expanded to
   Collapsed, so the contract is gated and seeks to its last frame while the
   expansion, authored as the Expanded state's own storyboard, keeps running.
   Suppressing only the half WinUI suppresses would leave a bar that grows
   smoothly and vanishes instantly.

   The delays stay either way: they are timing rather than travel, and without
   them the bar still pumps on every passing pointer, only instantly.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ScrollBar_themeresources.xaml#L530-L555 */
@media (prefers-reduced-motion: reduce) {
  ${host} .os-scrollbar .os-scrollbar-handle,
  ${host} .os-scrollbar .os-scrollbar-track {
    transition-duration: 0.01ms;
  }
}
`;
