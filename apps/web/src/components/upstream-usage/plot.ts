import { hueForSeriesSlot } from '../charts/palette';
import { withUniqueSeriesLegends, type ChartSeries } from '../charts/series-legends';
import type { UpstreamUsageMetricRecord } from '@floway-dev/gateway/browser';
import type { UsageMetricDisplay, UsageMetricUnit } from '@floway-dev/provider/browser';

export type UpstreamUsageGroupBy = 'upstream' | 'metric';
export interface UpstreamUsageChart {
  id: string;
  title: string;
  unit: UsageMetricUnit;
  entries: ChartSeries[];
  values: Map<string, Array<{ timestamp: number; value: number }>>;
}

export const buildUpstreamUsageCharts = (
  records: readonly UpstreamUsageMetricRecord[],
  groupBy: UpstreamUsageGroupBy,
  resolve: (upstreamId: string, key: string) => UsageMetricDisplay,
): UpstreamUsageChart[] => {
  const charts = new Map<string, UpstreamUsageChart>();
  const identities = new Map<string, UpstreamUsageMetricRecord>();
  for (const record of records) identities.set(JSON.stringify([record.upstreamId, record.key]), record);
  for (const [id, record] of identities) {
    const display = resolve(record.upstreamId, record.key);
    const chartId = JSON.stringify([groupBy === 'upstream' ? record.upstreamId : display.name, display.unit]);
    let chart = charts.get(chartId);
    if (chart === undefined) {
      chart = { id: chartId, title: groupBy === 'upstream' ? record.upstreamName : display.name, unit: display.unit, entries: [], values: new Map() };
      charts.set(chartId, chart);
    }
    const label = groupBy === 'upstream' ? display.name : record.upstreamName;
    chart.entries.push({ id, label, legend: label, hue: groupBy === 'upstream' ? hueForSeriesSlot(chart.entries.length) : record.upstreamHue });
    chart.values.set(id, []);
  }
  for (const record of records) {
    const id = JSON.stringify([record.upstreamId, record.key]);
    const display = resolve(record.upstreamId, record.key);
    const chartId = JSON.stringify([groupBy === 'upstream' ? record.upstreamId : display.name, display.unit]);
    charts.get(chartId)!.values.get(id)!.push({ timestamp: record.timestamp, value: record.value });
  }
  return [...charts.values()].map(chart => ({ ...chart, entries: withUniqueSeriesLegends(chart.entries) }));
};

export const gaugePoints = (observations: readonly { timestamp: number; value: number }[], start: number, end: number) => {
  const points = observations.map(point => ({ x: new Date(Math.max(start, point.timestamp)), y: point.value }));
  const latest = points.at(-1)!;
  if (latest.x.getTime() < end) points.push({ x: new Date(end), y: latest.y });
  return points;
};
