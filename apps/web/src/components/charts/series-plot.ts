import type { LineChartPoints } from '@fluentui/react-charts';
import { curveMonotoneX } from 'd3-shape';

import { colorForSlot } from './palette';
import type { ChartSeries } from './series-legends';

// The stroke every plot in this dashboard draws a series with: 2px, on a
// monotone curve so a bucket-to-bucket run reads as one movement rather than as
// a chain of segments, in the slot colour the legend beside it is already
// showing.
//
// The two forms differ in one thing, which is whether the points are drawn as
// well as joined. A line form marks each point, because a sparse series over a
// wide range is otherwise a line whose readings cannot be pointed at. An area
// form states its point radius once in `pointOptions` instead, so asking for
// markers here would set the size twice.
//
// What is deliberately NOT here is how a series becomes points. Each plot
// decides for itself what a hole is -- a metric undefined in a bucket, a
// reading a log axis cannot place -- and what a point carries with it, and
// those are readings of the data rather than of the chart.
export const areaSeries = (entry: ChartSeries, data: LineChartPoints['data']): LineChartPoints => ({
  legend: entry.legend,
  color: colorForSlot(entry.colorSlot),
  lineOptions: { strokeWidth: 2, curve: curveMonotoneX },
  data,
});

export const lineSeries = (entry: ChartSeries, data: LineChartPoints['data']): LineChartPoints => {
  const plotted = areaSeries(entry, data);
  return { ...plotted, lineOptions: { ...plotted.lineOptions, mode: 'lines+markers' } };
};
