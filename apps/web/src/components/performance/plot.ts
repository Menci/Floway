import type { ChartProps } from '@fluentui/react-charts';

import {
  performanceValue,
  resolvePerformanceGroup,
  type PerformanceDisplayRecord,
  type PerformanceGroupBy,
  type PerformanceMetric,
  type PerformanceLabels,
  type PerformancePercentile,
  type PerformanceRange,
} from './overview';
import type { ChartBucket } from '../charts/dashboard-time';
import { hueForSeriesSlot } from '../charts/palette';
import { withUniqueSeriesLegends, type ChartSeries, type SeriesLegendEntry } from '../charts/series-legends';
import { lineSeries } from '../charts/series-plot';

export interface PerformanceChartPointDetails { outputSpeed: number | null; ttft: number | null }
export interface PerformancePlot {
  data: ChartProps;
  details: Map<number, Map<string, PerformanceChartPointDetails>>;
  entries: ChartSeries[];
  weights: Map<string, number>;
  buckets: ChartBucket[];
  range: PerformanceRange;
  metric: PerformanceMetric;
}

export interface PerformanceChartOptions {
  seriesByGroup: ReadonlyMap<string, SeriesLegendEntry>;
}

export const buildPerformanceChart = (
  records: PerformanceDisplayRecord[],
  metric: PerformanceMetric,
  percentile: PerformancePercentile,
  groupBy: PerformanceGroupBy,
  labels: PerformanceLabels,
  buckets: ChartBucket[],
  range: PerformanceRange,
  options?: PerformanceChartOptions,
): PerformancePlot => {
  const groups = [...new Set(records.map(record => record.group))].sort();
  const entries = withUniqueSeriesLegends(groups.map((group, slot) => {
    if (options !== undefined) {
      const provided = options.seriesByGroup.get(group);
      if (provided === undefined) throw new TypeError(`Performance chart series metadata is missing for group: ${group}`);
      return provided;
    }
    return {
      id: group,
      label: resolvePerformanceGroup(group, groupBy, labels),
      hue: groupBy === 'upstream'
        ? labels.upstreamHues.get(group) ?? hueForSeriesSlot(slot)
        : hueForSeriesSlot(slot),
    };
  }));
  const values = new Map(records.map(record => [
    `${record.bucket}\0${record.group}`,
    record,
  ]));
  const weights = new Map(entries.map(entry => [
    entry.id,
    buckets.reduce((sum, bucket) => {
      const record = values.get(`${bucket.key}\0${entry.id}`);
      if (record === undefined) return sum;
      return sum + (metric === 'ttft' ? record.ttftSamples : record.tpotSamples);
    }, 0),
  ]));
  return {
    entries,
    weights,
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
        return data.length ? [lineSeries(entry, data.map(point => ({ ...point, markerSize: 3 })))] : [];
      }),
    },
  };
};
