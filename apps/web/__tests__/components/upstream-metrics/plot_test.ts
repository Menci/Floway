import { expect, it } from 'vitest';

import type { ResolvedUpstreamMetricDisplay, ResolvedUpstreamMetricDisplaySeries } from '../../../src/components/upstream-metrics/display-name';
import { buildUpstreamMetricsChart, gaugePoints, upstreamMetricsPlotRows } from '../../../src/components/upstream-metrics/plot';
import type { UpstreamMetricRecord } from '@floway-dev/gateway/browser';
import { upstreamMetricIdentityKey, type UpstreamMetricIdentity } from '@floway-dev/provider/browser';
import { resolveUpstreamMetricDisplays as resolveClaudeMetrics } from '@floway-dev/provider-claude-code/browser';

const upstream = { id: 'seat', kind: 'ollama' as const, name: 'Seat', hue: 210 };
const records: UpstreamMetricRecord[] = [
  { upstreamId: 'seat', name: 'usage', labels: {}, timestamp: 1_000, value: 20 },
  { upstreamId: 'seat', name: 'cost', labels: {}, timestamp: 1_000, value: 3 },
  { upstreamId: 'seat', name: 'credits', labels: {}, timestamp: 10_000, value: 200 },
  { upstreamId: 'seat', name: 'usage', labels: {}, timestamp: 61_000, value: 0 },
];
const resolve = (identity: UpstreamMetricIdentity): ResolvedUpstreamMetricDisplay => ({
  name: identity.name,
  labelKey: null,
  unit: identity.name === 'cost' ? 'usd' : identity.name === 'credits' ? 'credits' : 'percent',
  axisPriority: identity.name === 'usage' ? 100 : identity.name === 'cost' ? 60 : 40,
  windowSeconds: null,
  emptyValue: identity.name === 'usage' ? 0 : null,
  form: 'line',
  toDisplayValue: identity.name === 'usage' ? value => 100 - value : value => value,
});
const resolvedSeries = (source: readonly UpstreamMetricRecord[]): ResolvedUpstreamMetricDisplaySeries[] => {
  const groups = new Map<string, UpstreamMetricRecord[]>();
  for (const record of source) {
    const id = upstreamMetricIdentityKey(record);
    const group = groups.get(id);
    if (group === undefined) groups.set(id, [record]);
    else group.push(record);
  }
  return [...groups.values()].map(samples => ({
    identity: { name: samples[0]!.name, labels: samples[0]!.labels },
    display: resolve(samples[0]!),
    samples,
  }));
};

it('builds transformed gauge values and uses the raw latest value for empty semantics', () => {
  const chart = buildUpstreamMetricsChart(resolvedSeries(records), upstream);
  const usage = upstreamMetricIdentityKey({ name: 'usage', labels: {} });
  const credits = upstreamMetricIdentityKey({ name: 'credits', labels: {} });
  expect(chart.entries.map(entry => entry.unit)).toEqual(['percent', 'usd', 'credits']);
  expect(chart.entries.map(entry => entry.axisPriority)).toEqual([100, 60, 40]);
  expect(chart.values.get(usage)).toEqual([{ timestamp: 1_000, value: 80 }, { timestamp: 61_000, value: 100 }]);
  expect(chart.values.get(credits)).toEqual([{ timestamp: 10_000, value: 200 }]);
  expect([...chart.hiddenByDefault]).toEqual([usage]);
  expect(records.map(record => record.value)).toEqual([20, 3, 200, 0]);
});

it('uses the canonical identity for both Claude sources after aggregation', () => {
  const source = [
    { upstreamId: 'seat', name: 'quota.utilization', labels: { quota: 'five_hour' }, timestamp: 1_000, value: 25 },
    { upstreamId: 'seat', name: 'quota.utilization', labels: { quota: 'five_hour' }, timestamp: 61_000, value: 30 },
  ];
  const series = resolveClaudeMetrics(source, { quotaDisplay: 'remaining' });
  const chart = buildUpstreamMetricsChart(series, { ...upstream, kind: 'claude-code' });
  expect(chart.entries).toHaveLength(1);
  expect([...chart.values.values()][0]).toEqual([{ timestamp: 1_000, value: 75 }, { timestamp: 61_000, value: 70 }]);
});

it('uses current upstream identity and keeps sparse observation times', () => {
  const chart = buildUpstreamMetricsChart(resolvedSeries(records), { ...upstream, name: 'Renamed' });
  const usage = upstreamMetricIdentityKey({ name: 'usage', labels: {} });
  const credits = upstreamMetricIdentityKey({ name: 'credits', labels: {} });
  expect(chart.title).toBe('Renamed');
  expect(upstreamMetricsPlotRows(chart, 5_000, 120_000)).toEqual([
    { timestamp: 10_000, values: { [credits]: 200 } },
    { timestamp: 61_000, values: { [usage]: 100 } },
  ]);
});

it('retains only real observations within the requested range', () => {
  expect(gaugePoints([{ timestamp: 1_000, value: 20 }, { timestamp: 61_000, value: 0 }], 30_000, 120_000)).toEqual([{ timestamp: 61_000, value: 0 }]);
});
