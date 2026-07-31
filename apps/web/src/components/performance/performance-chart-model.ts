import type { ChartProps } from '@fluentui/react-charts';
import { curveMonotoneX } from 'd3-shape';

import {
  performanceValue,
  resolvePerformanceGroup,
  type PerformanceDisplayRecord,
  type PerformanceGroupBy,
  type PerformanceMetric,
  type PerformanceLabels,
  type PerformancePercentile,
  type PerformanceRange,
} from './performance-data';
import type { ChartBucket } from '../charts/dashboard-time';
import { colorForSlot } from '../charts/palette';
import { withUniqueSeriesLegends, type ChartSeries } from '../charts/series-legends';

export interface PerformanceChartPointDetails { outputSpeed: number | null; ttft: number | null }
export interface PerformanceChartModel {
  data: ChartProps;
  details: Map<number, Map<string, PerformanceChartPointDetails>>;
  entries: ChartSeries[];
  buckets: ChartBucket[];
  range: PerformanceRange;
  metric: PerformanceMetric;
}

export const buildPerformanceChart = (
  records: PerformanceDisplayRecord[],
  metric: PerformanceMetric,
  percentile: PerformancePercentile,
  groupBy: PerformanceGroupBy,
  labels: PerformanceLabels,
  buckets: ChartBucket[],
  range: PerformanceRange,
): PerformanceChartModel => {
  const groups = [...new Set(records.map(record => record.group))].sort();
  const entries = withUniqueSeriesLegends(groups.map((group, colorSlot) => ({
    id: group,
    label: resolvePerformanceGroup(group, groupBy, labels),
    colorSlot,
  })));
  const values = new Map(records.map(record => [`${record.bucket}\0${record.group}`, record]));
  return {
    entries,
    buckets,
    details: new Map(buckets.map(bucket => [
      bucket.date.getTime(),
      new Map(entries.flatMap(entry => {
        const record = values.get(`${bucket.key}\0${entry.id}`);
        return record ? [[entry.id, {
          outputSpeed: performanceValue(record, 'tokPerSec', percentile),
          ttft: performanceValue(record, 'ttft', percentile),
        }] as const] : [];
      })),
    ])),
    range,
    metric,
    data: {
      chartTitle: '',
      lineChartData: entries.flatMap(entry => {
        const data = buckets.flatMap(bucket => {
          const value = values.get(`${bucket.key}\0${entry.id}`);
          const y = value ? performanceValue(value, metric, percentile) : null;
          return y === null || y <= 0 ? [] : [{ x: bucket.date, y }];
        });
        return data.length
          ? [{
              legend: entry.legend,
              color: colorForSlot(entry.colorSlot),
              lineOptions: { strokeWidth: 2, curve: curveMonotoneX, mode: 'lines+markers' as const },
              data: data.map(point => ({ ...point, markerSize: 3 })),
            }]
          : [];
      }),
    },
  };
};
