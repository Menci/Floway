import { fluentComponents } from '../../fluent';

const { makeStyles } = fluentComponents;

// Fluent renders a chart's hover callout as an absolutely positioned popover
// *inside* the chart's own root rather than through a portal, and it treats the
// nearest clipping ancestor as the popover's overflow boundary. The chart's
// own root is reached through its `styles` slot, so it must remain unclipped.
// Measured on the Performance chart with ten series, a clipped callout wanting
// 254px was given 154px and its last row was cut through the middle.
//
// The callout surface keeps the flyout fill, stroke and corner that
// `winui/controls/popover.css.ts` gives every `.fui-PopoverSurface`: WinUI
// fills both FlyoutPresenter and ToolTip with AcrylicInAppFillColorDefaultBrush
// and outlines both with the flyout stroke, so the surface needs nothing said
// about its paint here in either colour scheme.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToolTip_themeresources.xaml#L44
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/FlyoutPresenter_themeresources.xaml#L5
export const useUnclippedChartFrame = makeStyles({
  root: {
    overflow: 'visible',
    // Axis labels take Caption, the step WinUI sets a chart's own annotations
    // in and the smallest size its ramp states. Fluent's charts draw the ticks
    // at 10px SemiBold, which is below every step WinUI has and heavier than
    // the body text the labels sit beside.
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBlock_themeresources.xaml#L3
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBlock_themeresources.xaml#L19-L22
    '& .tick text': {
      fontSize: 'var(--fontSizeBase200)',
      fontWeight: 'var(--fontWeightRegular)',
    },
    // The outermost ticks are centred on the plot's own edges, so half of each
    // label hangs past the axis. Anchoring them inward keeps the range the
    // chart actually covers legible without narrowing the plot.
    '& .fui-cart__xAxis .tick:first-of-type text': { textAnchor: 'start' },
    '& .fui-cart__xAxis .tick:last-of-type text': { textAnchor: 'end' },
    // A callout renderer that drops every row returns null, and Fluent answers
    // a null custom callout by falling back to its own built-in stack callout
    // rather than by closing the popover. Our callouts are tables, so the
    // absence of one identifies that fallback and it is hidden.
    '& .fui-PopoverSurface:not(:has(table))': { display: 'none' },
    // This popover is a tooltip in everything but DOM: it opens on hover,
    // describes the point under the pointer, and takes no pointer input, which
    // is what XAML's ToolTip is. It therefore takes ToolTipBorderPadding --
    // 9,6,9,8 in XAML's left, top, right, bottom order -- rather than the
    // flyout content padding Fluent spends on it.
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToolTip_themeresources.xaml#L50
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToolTip_themeresources.xaml#L76
    '& .fui-PopoverSurface': {
      padding: '6px 9px 8px 9px',
      pointerEvents: 'none',
    },
  },
});
