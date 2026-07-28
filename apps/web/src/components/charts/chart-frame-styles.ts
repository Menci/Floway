import { fluentComponents } from '../../fluent';

const { makeStyles } = fluentComponents;

// Fluent renders a chart's hover callout as an absolutely positioned popover
// *inside* the chart's own root rather than through a portal, and it treats the
// nearest clipping ancestor as the popover's overflow boundary. A clipping
// frame therefore does more than hide the overflow: it caps the popover's
// height. Measured on the Performance chart with ten series, a callout wanting
// 254px was given 154px and its last row was cut through the middle.
//
// Two layers clip, and freeing one only moves the boundary to the other: the
// chart's own root, reached through the component's `styles` slot, and the
// Fluent `Card` that frames it, whose base styles set `overflow: hidden` — so
// the card needs a Griffel class that `mergeClasses` can resolve against those
// base styles, not a utility class racing them on stylesheet order.
export const useUnclippedChartFrame = makeStyles({
  root: {
    overflow: 'visible',
  },
});
