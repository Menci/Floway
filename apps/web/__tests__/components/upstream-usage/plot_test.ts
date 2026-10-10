import { expect, it } from 'vitest';

import { buildUpstreamUsageCharts, gaugePoints, upstreamUsagePlotRows } from '../../../src/components/upstream-usage/plot';
import type { UpstreamUsageMetricRecord } from '@floway-dev/gateway/browser';

const records: UpstreamUsageMetricRecord[] = [
  { upstreamId: 'up-1', key: 'usage', timestamp: 1_000, value: 20 },
  { upstreamId: 'up-1', key: 'cost', timestamp: 1_000, value: 3 },
  { upstreamId: 'up-1', key: 'credits', timestamp: 10_000, value: 200 },
  { upstreamId: 'up-2', key: 'usage', timestamp: 20_000, value: 40 },
  { upstreamId: 'up-1', key: 'usage', timestamp: 61_000, value: 0 },
];
const upstreams = new Map([['up-1', { id: 'up-1', kind: 'ollama' as const, name: 'First', hue: 210 }], ['up-2', { id: 'up-2', kind: 'ollama' as const, name: 'Second', hue: 20 }]]);
const resolve = (_upstreamId: string, key: string) => ({ name: key, metricId: key, unit: key === 'cost' ? 'usd' as const : key === 'credits' ? 'credits' as const : 'percent' as const, windowMinutes: null });

it('builds one comparison choice per upstream with all independently measured units', () => {
  const charts = buildUpstreamUsageCharts(records, 'upstream', upstreams, resolve);
  expect(charts.map(chart => [chart.id, chart.title, chart.entries.map(entry => entry.unit)])).toEqual([['up-1', 'First', ['percent', 'usd', 'credits']], ['up-2', 'Second', ['percent']]]);
  expect(charts[0]!.values.get(JSON.stringify(['up-1', 'usage']))).toEqual([{ timestamp: 1_000, value: 20 }, { timestamp: 61_000, value: 0 }]);
});

it('compares one metric across all upstreams on a single unit axis', () => {
  const charts = buildUpstreamUsageCharts(records, 'metric', upstreams, resolve);
  expect(charts.find(chart => chart.id === 'usage')!.entries.map(entry => [entry.label, entry.unit])).toEqual([['First', 'percent'], ['Second', 'percent']]);
  expect(charts.every(chart => new Set(chart.entries.map(entry => entry.unit)).size === 1)).toBe(true);
});

it('uses current upstream names and hues and omits deleted identities from display', () => {
  const current = new Map([['up-1', { ...upstreams.get('up-1')!, name: 'Renamed', hue: 300 }]]);
  const charts = buildUpstreamUsageCharts(records, 'metric', current, resolve);
  expect(charts.find(chart => chart.id === 'usage')!.entries).toMatchObject([{ label: 'Renamed', hue: 300 }]);
  expect(charts.every(chart => chart.entries.every(entry => entry.id.startsWith('["up-1"')))).toBe(true);
});

it('starts at the last known value, preserves a reset to zero, and carries gauges to the right edge', () => {
  expect(gaugePoints([{ timestamp: 1_000, value: 20 }, { timestamp: 61_000, value: 0 }], 30_000, 120_000)).toEqual([{ timestamp: 30_000, value: 20 }, { timestamp: 61_000, value: 0 }, { timestamp: 120_000, value: 0 }]);
  expect(gaugePoints([{ timestamp: 61_000, value: 20 }], 30_000, 120_000)[0]!.timestamp).toBe(61_000);
});

it('aligns independent observation times for step plots without inventing readings before the first observation', () => {
  const chart = buildUpstreamUsageCharts(records, 'metric', upstreams, resolve).find(chart => chart.id === 'usage')!;
  const first = JSON.stringify(['up-1', 'usage']);
  const second = JSON.stringify(['up-2', 'usage']);
  expect(upstreamUsagePlotRows(chart, 5_000, 120_000)).toEqual([
    { timestamp: 5_000, values: { [first]: 20 } },
    { timestamp: 20_000, values: { [first]: 20, [second]: 40 } },
    { timestamp: 61_000, values: { [first]: 0, [second]: 40 } },
    { timestamp: 120_000, values: { [first]: 0, [second]: 40 } },
  ]);
});
