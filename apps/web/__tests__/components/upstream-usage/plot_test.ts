import { expect, it } from 'vitest';

import { buildUpstreamUsageCharts, gaugePoints } from '../../../src/components/upstream-usage/plot';
import type { UpstreamUsageMetricRecord } from '@floway-dev/gateway/browser';

const records: UpstreamUsageMetricRecord[] = [
  { upstreamId: 'up-1', key: 'usage', timestamp: 1_000, value: 20, provider: 'ollama', upstreamName: 'First', upstreamHue: 210 },
  { upstreamId: 'up-1', key: 'cost', timestamp: 1_000, value: 3, provider: 'ollama', upstreamName: 'First', upstreamHue: 210 },
  { upstreamId: 'up-2', key: 'usage', timestamp: 1_000, value: 40, provider: 'ollama', upstreamName: 'Second', upstreamHue: 20 },
  { upstreamId: 'up-1', key: 'usage', timestamp: 61_000, value: 0, provider: 'ollama', upstreamName: 'First', upstreamHue: 210 },
];
const resolve = (_upstreamId: string, key: string) => ({ name: key, unit: key === 'cost' ? 'usd' as const : 'percent' as const, windowMinutes: null });

it('groups upstream gauges without combining distinct metrics or measurement units', () => {
  const charts = buildUpstreamUsageCharts(records, 'upstream', resolve);
  expect(charts.map(chart => [chart.title, chart.unit, chart.entries.length])).toEqual([['First', 'percent', 1], ['First', 'usd', 1], ['Second', 'percent', 1]]);
  expect(charts[0]!.values.get(JSON.stringify(['up-1', 'usage']))).toEqual([{ timestamp: 1_000, value: 20 }, { timestamp: 61_000, value: 0 }]);
});

it('groups by metric name with independent upstream curves', () => {
  const charts = buildUpstreamUsageCharts(records, 'metric', resolve);
  expect(charts[0]!.entries.map(entry => entry.label)).toEqual(['First', 'Second']);
  expect([...charts[0]!.values.values()]).toEqual([[{ timestamp: 1_000, value: 20 }, { timestamp: 61_000, value: 0 }], [{ timestamp: 1_000, value: 40 }]]);
});

it('starts at the last known value, preserves a reset to zero, and carries gauges to the right edge', () => {
  expect(gaugePoints([{ timestamp: 1_000, value: 20 }, { timestamp: 61_000, value: 0 }], 30_000, 120_000)).toEqual([{ x: new Date(30_000), y: 20 }, { x: new Date(61_000), y: 0 }, { x: new Date(120_000), y: 0 }]);
  expect(gaugePoints([{ timestamp: 61_000, value: 20 }], 30_000, 120_000)[0]!.x).toEqual(new Date(61_000));
});
