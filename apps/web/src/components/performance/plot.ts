import type { ChartProps } from '@fluentui/react-charts';

import {
  performanceValue,
  resolvePerformanceGroup,
  type PerformanceDisplayRecord,
  type PerformanceGroupBy,
  type PerformanceMetric,
  type PerformanceLabels,
  type PerformancePercentiles,
  type PerformanceRange,
} from './overview';
import { dashboardBucketFrames, formatBucketInterval, type ChartBucket } from '../charts/dashboard-time';
import { hueForSeriesSlot } from '../charts/palette';
import { withUniqueSeriesLegends, type ChartSeries } from '../charts/series-legends';
import { lineSeries } from '../charts/series-plot';

export interface PerformanceChartPointDetails { outputSpeed: number | null; ttft: number | null }
export interface PerformancePlot {
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
  percentiles: PerformancePercentiles,
  groupBy: PerformanceGroupBy,
  labels: PerformanceLabels,
  buckets: ChartBucket[],
  range: PerformanceRange,
): PerformancePlot => {
  const groups = [...new Set(records.map(record => record.group))].sort();
  const entries = withUniqueSeriesLegends(groups.map((group, slot) => ({
    id: group,
    label: resolvePerformanceGroup(group, groupBy, labels),
    hue: groupBy === 'upstream'
      ? labels.upstreamHues.get(group) ?? hueForSeriesSlot(slot)
      : hueForSeriesSlot(slot),
  })));
  const values = new Map(records.map(record => [
    `${record.bucket}\0${record.group}`,
    record,
  ]));
  return {
    entries,
    buckets,
    details: new Map(buckets.map(bucket => [
      bucket.date.getTime(),
      new Map(entries.flatMap(entry => {
        const record = values.get(`${bucket.key}\0${entry.id}`);
        return record ? [[entry.id, {
          outputSpeed: performanceValue(record, 'tokPerSec', percentiles.tokPerSec),
          ttft: performanceValue(record, 'ttft', percentiles.ttft),
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
          const y = value ? performanceValue(value, metric, percentiles[metric]) : null;
          return y === null || y <= 0 ? [] : [{ x: bucket.date, y }];
        });
        return data.length ? [lineSeries(entry, data.map(point => ({ ...point, markerSize: 3 })))] : [];
      }),
    },
  };
};

export const performanceBuckets = (range: PerformanceRange, now: number): ChartBucket[] =>
  dashboardBucketFrames(range, now).map(frame => ({ ...frame, label: formatBucketInterval(frame) }));
