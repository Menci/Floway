import type { UpstreamMetricsMetadata } from './data';
import type { ResolvedUpstreamMetricDisplaySeries } from './display-name';
import { hueForSeriesSlot } from '../charts/palette';
import type { SeriesLegendEntry } from '../charts/series-legends';
import { upstreamMetricIdentityKey, type UpstreamMetricUnit } from '@floway-dev/provider/browser';

export interface UpstreamMetricsSeries extends SeriesLegendEntry { unit: UpstreamMetricUnit; axisPriority: number; form: 'line' | 'area' }
export interface UpstreamMetricsChart {
  id: string;
  title: string;
  entries: UpstreamMetricsSeries[];
  values: Map<string, Array<{ timestamp: number; value: number }>>;
  hiddenByDefault: Set<string>;
}

export const buildUpstreamMetricsChart = (
  series: readonly ResolvedUpstreamMetricDisplaySeries[],
  upstream: UpstreamMetricsMetadata,
): UpstreamMetricsChart => {
  const chart: UpstreamMetricsChart = { id: upstream.id, title: upstream.name, entries: [], values: new Map(), hiddenByDefault: new Set() };
  for (const { identity, display, samples } of series) {
    const id = upstreamMetricIdentityKey(identity);
    chart.entries.push({ id, label: display.name, unit: display.unit, axisPriority: display.axisPriority, form: display.form, hue: hueForSeriesSlot(chart.entries.length) });
    chart.values.set(id, samples.map(sample => ({ timestamp: sample.timestamp, value: display.toDisplayValue(sample.value) })));
    const latest = samples.at(-1)?.value;
    if (display.emptyValue !== null && latest === display.emptyValue) chart.hiddenByDefault.add(id);
  }
  return chart;
};

export const gaugePoints = (observations: readonly { timestamp: number; value: number }[], start: number, end: number) =>
  observations.filter(point => point.timestamp >= start && point.timestamp <= end);

export const upstreamMetricsPlotRows = (chart: UpstreamMetricsChart, start: number, end: number): Array<{ timestamp: number; values: Record<string, number> }> => {
  const changes = new Map<number, Array<{ id: string; value: number }>>();
  for (const [id, observations] of chart.values) {
    for (const point of gaugePoints(observations, start, end)) {
      const atTime = changes.get(point.timestamp);
      const change = { id, value: point.value };
      if (atTime === undefined) changes.set(point.timestamp, [change]);
      else atTime.push(change);
    }
  }
  return [...changes].sort(([left], [right]) => left - right).map(([timestamp, atTime]) => ({ timestamp, values: Object.fromEntries(atTime.map(change => [change.id, change.value])) }));
};
