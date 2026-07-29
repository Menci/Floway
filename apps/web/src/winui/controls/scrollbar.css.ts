// The scrollbar, restyled from OverlayScrollbars' defaults onto WinUI 3's.
//
// WinUI's scrollbar is conscious: at rest it is a bare 2px rail with no track
// behind it, and under the pointer it widens to a 6px pill over a track. The
// two libraries disagree about what the pointer changes. OverlayScrollbars
// walks the handle through three opacities and leaves its width alone; WinUI
// holds one colour across rest, hover and press -- ControlStrongFillColor is
// stated identically for all three -- and moves the geometry instead.
//
// ScrollBarThumbStrokeThickness names the expanded width and
// ScrollBarCornerRadius confirms it: a 3px radius is a full round-off only on a
// 6px pill.
//
// The expanded track is AcrylicInAppFillColorDefaultBrush, an acrylic material
// the theme dictionaries reference but never declare, and which the web has no
// equivalent of. The layer fill stands in for it: it is the declared resource
// closest in role, a translucent sheet meant to sit over content.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ScrollBar_themeresources.xaml
export const scrollbarCss = `
/* Rail and handle geometry. ScrollBarSize is the rail; the handle collapses to
   the 2px the template gives it at rest and expands to ScrollBarThumbStrokeThickness
   under the pointer, never shorter than ScrollBarVerticalThumbMinHeight. */
.floway-scroll-area[data-overlayscrollbars='host'] .os-scrollbar {
  --os-size: 12px;
  --os-handle-border-radius: 3px;
  --os-handle-min-size: 30px;
  --os-handle-bg: var(--winui-control-strong-fill-default);
  --os-handle-bg-hover: var(--winui-control-strong-fill-default);
  --os-handle-bg-active: var(--winui-control-strong-fill-default);
}

.floway-scroll-area[data-overlayscrollbars='host'] .os-scrollbar-vertical .os-scrollbar-handle {
  width: 6px;
}

.floway-scroll-area[data-overlayscrollbars='host'] .os-scrollbar-horizontal .os-scrollbar-handle {
  height: 6px;
}

.floway-scroll-area[data-overlayscrollbars='host'] .os-scrollbar-vertical:not(:hover) .os-scrollbar-handle {
  width: 2px;
}

.floway-scroll-area[data-overlayscrollbars='host'] .os-scrollbar-horizontal:not(:hover) .os-scrollbar-handle {
  height: 2px;
}

/* The track is drawn only while the scrollbar is expanded, which is what makes
   the rest state read as a hairline against the content rather than as a
   channel cut into it. */
.floway-scroll-area[data-overlayscrollbars='host'] .os-scrollbar:hover .os-scrollbar-track {
  background-color: var(--winui-layer-fill-default);
}
`;
