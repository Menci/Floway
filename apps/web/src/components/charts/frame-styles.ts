import { fluentComponents } from '../../fluent';

const { makeStyles } = fluentComponents;

// Fluent renders a chart's hover callout as an absolutely positioned popover
// inside the chart's own root rather than through a portal, and treats the
// nearest clipping ancestor as the popover's overflow boundary.
export const useChartFrame = makeStyles({
  root: {
    overflow: 'visible',
    // Fluent's area form draws no point until one is hovered, leaving the bucket
    // count invisible at rest, so every form in the dashboard marks its buckets
    // alike. Radius and stroke width together give a marker its diameter -- 2px
    // of radius inside a 1.5px stroke reads as 5.5px beside the 2px series
    // stroke `series-plot.ts` draws. The highlight disc Fluent moves under the
    // pointer keeps its own size.
    '& circle:not([id*="staticHighlightCircle"])': { r: '2px', strokeWidth: '1.5px' },
    // Axis labels take Caption, the floor of WinUI's type ramp; WinUI ships no
    // chart, and Fluent's own 10px SemiBold ticks sit below every step it has.
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBlock_themeresources.xaml#L3
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBlock_themeresources.xaml#L19-L22
    '& .tick text': {
      fontSize: 'var(--fontSizeBase200)',
      fontWeight: 'var(--fontWeightRegular)',
    },
    // The outermost ticks are centred on the plot's own edges, so half of each
    // label hangs past the axis.
    '& .fui-cart__xAxis .tick:first-of-type text': { textAnchor: 'start' },
    '& .fui-cart__xAxis .tick:last-of-type text': { textAnchor: 'end' },
    // Fluent answers a null custom callout by falling back to its own built-in
    // stack callout rather than by closing the popover. Our callouts are
    // tables, so the absence of one identifies that fallback.
    '& .fui-PopoverSurface:not(:has(table))': { display: 'none' },
    // This popover is a tooltip in everything but DOM, so it takes
    // ToolTipBorderPadding (9,6,9,8 in XAML's LTRB order) rather than the
    // flyout content padding Fluent spends on it.
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToolTip_themeresources.xaml#L50
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToolTip_themeresources.xaml#L76
    //
    // The fill is translucent over a blur because this callout is large and
    // covers the lines it describes; the flat FallbackColor ../../winui/tokens.ts
    // takes for AcrylicInAppFillColorDefaultBrush is right for a flyout over a
    // page and wrong here.
    '& .fui-PopoverSurface': {
      backdropFilter: 'blur(8px)',
      backgroundColor: 'rgba(var(--winui-acrylic-in-app-fill-default-rgb), 0.86)',
      padding: '6px 9px 8px 9px',
      pointerEvents: 'none',
    },
  },
});
