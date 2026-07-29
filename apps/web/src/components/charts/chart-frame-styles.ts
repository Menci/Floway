import { fluentComponents } from '../../fluent';

const { makeStyles } = fluentComponents;

// Fluent renders a chart's hover callout as an absolutely positioned popover
// *inside* the chart's own root rather than through a portal, and it treats the
// nearest clipping ancestor as the popover's overflow boundary. The chart's
// own root is reached through its `styles` slot, so it must remain unclipped.
// Measured on the Performance chart with ten series, a clipped callout wanting
// 254px was given 154px and its last row was cut through the middle.
export const useUnclippedChartFrame = makeStyles({
  root: {
    overflow: 'visible',
    '& .fui-PopoverSurface': {
      backdropFilter: 'blur(8px)',
      backgroundColor: 'color-mix(in srgb, var(--colorNeutralBackground1) 86%, transparent)',
      padding: '6px 8px',
      pointerEvents: 'none',
    },
  },
});
