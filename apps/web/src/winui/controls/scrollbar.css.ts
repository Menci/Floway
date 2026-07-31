// The scrollbar, restyled from OverlayScrollbars' defaults onto WinUI 3's.
//
// WinUI's scrollbar is conscious: at rest it is a bare hairline with no track
// behind it, and under the pointer it widens to a pill over a track. The two
// libraries disagree about what the pointer changes. OverlayScrollbars walks
// the handle through three opacities and leaves its width alone; WinUI holds
// one colour across rest, hover and press — ScrollBarThumbFill, its PointerOver
// and its Pressed are all ControlStrongFillColorDefaultBrush — and moves the
// geometry instead.
//
// The visible pill is narrower than the thumb the template animates, because
// the thumb is a Rectangle stroked with ScrollBarThumbBorderBrush, which is
// ControlFillColorTransparentBrush, at ScrollBarThumbStrokeThickness. A XAML
// stroke straddles the edge, so 6px of transparent stroke eats 3px from each
// side and the fill that remains is the thumb width less 6: the expanded thumb
// animates to ScrollBarSize, 12, and reads as a 6px pill; the contracted one
// returns to ScrollBarVerticalThumbMinWidth, 8, and reads as a 2px hairline.
// ScrollBarCornerRadius confirms the expanded reading — a 3px radius is a full
// round-off only on a 6px pill.
//
// The expanded track is AcrylicInAppFillColorDefaultBrush. That brush declares
// a flat FallbackColor for where acrylic cannot be composited, and ../tokens.ts
// carries it -- but the fallback is opaque, and a scrollbar track sits over the
// content it scrolls. The layer fill stands in instead: it is the declared
// resource closest in role, a translucent sheet meant to sit over content.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Materials/Acrylic/AcrylicBrush_themeresources.xaml#L96
//
// Every rule here excludes the opted-out subtree in its selector rather than
// through a token indirection, because what it states is geometry Fluent never
// declares — see ../tokens.ts for both mechanisms.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ScrollBar_themeresources.xaml#L26-L30
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ScrollBar_themeresources.xaml#L180-L185
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ScrollBar_themeresources.xaml#L190
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ScrollBar_themeresources.xaml#L394-L395
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ScrollBar_themeresources.xaml#L484
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ScrollBar_themeresources.xaml#L587
import { notOptedOut } from '../tokens';

const host = `.floway-scroll-area[data-overlayscrollbars='host']${notOptedOut}`;

export const scrollbarCss = `
/* Rail geometry and thumb colour. ScrollBarSize is the rail; the handle is
   never shorter than ScrollBarVerticalThumbMinHeight along the scroll axis. */
${host} .os-scrollbar {
  --os-size: 12px;
  --os-handle-border-radius: 3px;
  --os-handle-min-size: 30px;
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
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ScrollBar_themeresources.xaml#L173-L189
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ScrollBar_themeresources.xaml#L528-L601 */
${host} .os-scrollbar-vertical .os-scrollbar-handle {
  width: 6px;
  transition-property: width;
  transition-duration: var(--winui-control-fast-animation-duration);
  transition-timing-function: var(--winui-control-fast-out-slow-in-easing);
  transition-delay: 400ms;
}

${host} .os-scrollbar-horizontal .os-scrollbar-handle {
  height: 6px;
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
   WinUI gives the track and buttons either side of the thumb's travel. */
${host} .os-scrollbar .os-scrollbar-track {
  transition-property: background-color;
  transition-duration: var(--winui-control-faster-animation-duration);
}

${host} .os-scrollbar:hover .os-scrollbar-track {
  background-color: var(--winui-layer-fill-default);
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
