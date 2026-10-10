// Syncfusion.Calendar.WinUI 35.1.39: Themes/calendar.xaml, calendaritem.xaml,
// themeresources.xaml and Core/Themes/DensityStyles/Standard.xaml.
// https://www.nuget.org/packages/Syncfusion.Calendar.WinUI/35.1.39
export const RANGE_CELL_SIZE = 40;
export const RANGE_CELL_BORDER = 2;
export const RANGE_CELL_STROKE = 1.5;
export const RANGE_COLUMNS = 7;
export const RANGE_ROWS = 6;
export const RANGE_LARGE_COLUMNS = 4;
export const RANGE_CONTENT_SIZE = RANGE_COLUMNS * RANGE_CELL_SIZE;
export const RANGE_HEADER_FADE_MS = 167;
export const RANGE_DRILL_OUT_MS = 233;
export const RANGE_DRILL_MS = 733;
export const RANGE_DRILL_EASING = 'cubic-bezier(0.1, 0.9, 0.2, 1)';

// NavigatorState.AnimateNavigation uses ExponentialEase(10), whose mode defaults
// to EaseOut. Its unset DoubleAnimation duration is the native one second.
// https://www.nuget.org/packages/Syncfusion.Calendar.WinUI/35.1.39
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/core/inc/animation.h#L25
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/core/inc/EasingFunctions.h#L56
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/components/animation/EasingFunctions.cpp#L139-L146
export const RANGE_NAVIGATION_MS = 1000;
export const RANGE_SNAPSHOT_MS = 500;
export const rangeNavigationFrames = (distance: number, entering: boolean): Keyframe[] => Array.from({ length: RANGE_NAVIGATION_MS + 1 }, (_, ms) => {
  const offset = ms / RANGE_NAVIGATION_MS;
  const eased = 1 - (Math.exp(10 * (1 - offset)) - 1) / (Math.exp(10) - 1);
  return { offset, transform: `translateX(${distance * (entering ? 1 - eased : -eased)}px)` };
});
