import type { ChartProps } from '@fluentui/react-charts';
import { curveMonotoneX } from 'd3-shape';

import {
  performanceValue,
  resolvePerformanceGroup,
  type PerformanceDisplayRecord,
  type PerformanceGroupBy,
  type PerformanceMetric,
  type PerformanceOverviewResponse,
  type PerformancePercentile,
  type PerformanceRange,
} from './performance-data';
import { colorForSlot } from '../charts/palette';

export interface PerformanceBucket { key: string; label: string; date: Date }
export interface PerformanceChartEntry { id: string; label: string; colorSlot: number }
export interface PerformanceChartModel {
  data: ChartProps;
  entries: PerformanceChartEntry[];
  buckets: PerformanceBucket[];
  range: PerformanceRange;
  metric: PerformanceMetric;
}

export function buildPerformanceChart(
  records: PerformanceDisplayRecord[],
  metric: PerformanceMetric,
  percentile: PerformancePercentile,
  groupBy: PerformanceGroupBy,
  overview: PerformanceOverviewResponse,
  upstreamNames: ReadonlyMap<string, string>,
  buckets: PerformanceBucket[],
  range: PerformanceRange,
): PerformanceChartModel {
  const groups = [...new Set(records.map(record => record.group))].sort();
  const entries = groups.map((group, colorSlot) => ({
    id: group,
    label: resolvePerformanceGroup(group, groupBy, overview, upstreamNames),
    colorSlot,
  }));
  const values = new Map(records.map(record => [`${record.bucket}\0${record.group}`, record]));
  return {
    entries,
    buckets,
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
              legend: entry.id,
              color: colorForSlot(entry.colorSlot),
              lineOptions: { strokeWidth: 2, curve: curveMonotoneX, mode: 'lines+markers' as const },
              data: data.map(point => ({ ...point, markerSize: 3 })),
            }]
          : [];
      }),
    },
  };
}
