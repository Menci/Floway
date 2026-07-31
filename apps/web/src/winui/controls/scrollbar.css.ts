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

${host} .os-scrollbar-vertical .os-scrollbar-handle {
  width: 6px;
}

${host} .os-scrollbar-horizontal .os-scrollbar-handle {
  height: 6px;
}

${host} .os-scrollbar-vertical:not(:hover) .os-scrollbar-handle {
  width: 2px;
}

${host} .os-scrollbar-horizontal:not(:hover) .os-scrollbar-handle {
  height: 2px;
}

/* The track is drawn only while the scrollbar is expanded, which is what makes
   the rest state read as a hairline against the content rather than as a
   channel cut into it. */
${host} .os-scrollbar:hover .os-scrollbar-track {
  background-color: var(--winui-layer-fill-default);
}
`;
