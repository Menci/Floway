import type { LineChartPoints } from '@fluentui/react-charts';
import { curveMonotoneX } from 'd3-shape';

import { colorForSlot } from './palette';
import type { ChartSeries } from './series-legends';

// An area form sets its point radius through `pointOptions`, so markers here
// would size points twice.
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
