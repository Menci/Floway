import { fluentComponents } from '../../fluent';

const { makeStyles } = fluentComponents;

// Axis labels use Caption, the floor of WinUI's type ramp.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBlock_themeresources.xaml#L3
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBlock_themeresources.xaml#L19-L22
export const chartTickStyle = { fill: 'var(--colorNeutralForeground2)', fontSize: 'var(--fontSizeBase200)', fontWeight: 'var(--fontWeightRegular)' } as const;

// Chart callouts take ToolTipBorderPadding (9,6,9,8 in XAML's LTRB order).
// Their translucent fill and blur keep the chart visible beneath the table.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToolTip_themeresources.xaml#L50
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToolTip_themeresources.xaml#L76
export const chartCalloutStyle = {
  backdropFilter: 'blur(8px)',
  backgroundColor: 'rgba(var(--winui-acrylic-in-app-fill-default-rgb), 0.86)',
  padding: '6px 9px 8px 9px',
  pointerEvents: 'none',
  width: 'max-content',
  maxWidth: 'none',
} as const;

export const chartCalloutSurfaceStyle = {
  ...chartCalloutStyle,
  border: '1px solid var(--winui-surface-stroke-flyout)',
  borderRadius: 'var(--borderRadiusMedium)',
  boxShadow: 'var(--shadow16)',
} as const;

// Fluent renders a chart's hover callout as an absolutely positioned popover
// inside the chart's own root rather than through a portal, and treats the
// nearest clipping ancestor as the popover's overflow boundary.
export const useChartFrame = makeStyles({
  root: {
    overflow: 'visible',
    // Axis readings are a column of values, and the one an axis ticks into
    // changes width as the range moves; tabular figures keep the labels on
    // their gridlines instead of letting a narrower `1` drift them.
    '& .tick text, & .recharts-cartesian-axis-tick text': {
      fontVariantNumeric: 'tabular-nums',
      fontSize: chartTickStyle.fontSize,
      fontWeight: chartTickStyle.fontWeight,
    },
    // Both chart renderers centre their outermost ticks on the plot edges. The
    // shared anchors keep the labels inside the frame and align their visible
    // edges even though Fluent Charts and Recharts emit different SVG trees.
    '& .fui-cart__xAxis .tick:first-of-type text, & .recharts-xAxis-tick-labels .recharts-cartesian-axis-tick-label:first-of-type text': { textAnchor: 'start' },
    '& .fui-cart__xAxis .tick:last-of-type text, & .recharts-xAxis-tick-labels .recharts-cartesian-axis-tick-label:last-of-type text': { textAnchor: 'end' },
    // Fluent answers a null custom callout by falling back to its own built-in
    // stack callout rather than by closing the popover. Our callouts are
    // tables, so the absence of one identifies that fallback.
    '& .fui-PopoverSurface:not(:has(table))': { display: 'none' },
    '& .fui-PopoverSurface': {
      ...chartCalloutStyle,
    },
  },
});
