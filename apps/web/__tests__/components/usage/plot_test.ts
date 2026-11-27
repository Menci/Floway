import { describe, expect, it } from 'vitest';

import type { ChartBucket } from '../../../src/components/charts/dashboard-time';
import { buildSearchChart, buildTokenChart, summarizeCounters } from '../../../src/components/usage/plot';
import type { ChartPlot, DisplayUsageRecord } from '../../../src/components/usage/types';

const areaPlot = (plot: ChartPlot) => {
  if (plot.form !== 'area') throw new Error(`expected an area plot, got ${plot.form}`);
  return plot.data;
};

const RECORD_HOUR = '2026-07-28T04';
const bucket: ChartBucket = {
  key: RECORD_HOUR,
  label: '12:00 - 13:00',
  date: new Date(`${RECORD_HOUR}:00:00.000Z`),
  start: Date.parse(`${RECORD_HOUR}:00:00.000Z`),
  end: Date.parse(`${RECORD_HOUR}:00:00.000Z`) + 3_600_000,
};

const record = (metrics: DisplayUsageRecord['metrics'], group = 'key-1'): DisplayUsageRecord => ({
  bucket: bucket.key,
  group,
  requests: 1,
  metrics,
  cost: null,
});

const chart = (metrics: DisplayUsageRecord['metrics']) => buildTokenChart({
  records: [record(metrics)],
  dimensionOptions: [{ value: 'key-1', label: 'Key 1' }],
  metric: 'cachedRate',
  range: 'today',
  buckets: [bucket],
});

describe('cost chart series', () => {
  it('does not turn unavailable pricing into measured zero cost', () => {
    const model = buildTokenChart({
      records: [record({ input_tokens: '10' })],
      dimensionOptions: [{ value: 'key-1', label: 'Key 1' }],
      metric: 'cost',
      range: 'today',
      buckets: [bucket],
    });
    expect(areaPlot(model.plot).lineChartData![0]!.data).toEqual([]);
  });
});

describe('series identity', () => {
  it('rejects a series group missing from the overview dimension values', () => {
    expect(() => buildTokenChart({
      records: [record({ input_tokens: '1' }, 'missing')],
      dimensionOptions: [{ value: 'known', label: 'Known' }],
      metric: 'total',
      range: 'today',
      buckets: [bucket],
    })).toThrow(TypeError);
  });
});

describe('bucket callout figures', () => {
  const metrics = {
    input_tokens: '20',
    input_cache_read_tokens: '300',
    input_cache_write_tokens: '4000',
    input_image_tokens: '50000',
    output_tokens: '600000',
    output_image_tokens: '7000000',
  } as const;
  const counters = chart(metrics).details.get(bucket.key)!.get('key-1')!;

  it('adds the disjoint counters instead of joining them', () => {
    expect(summarizeCounters(counters)).toMatchObject({
      prompt: '54320',
      prefill: '54020',
      output: '7600000',
      total: '7654320',
    });
  });
});

describe('search chart', () => {
  const searchRecord = (provider: string, requests: number) => ({
    provider,
    keyId: 'key-1',
    keyName: 'Key 1',
    hour: RECORD_HOUR,
    requests,
  });
  const searchChart = (records: ReturnType<typeof searchRecord>[]) => buildSearchChart({
    search: { records, keys: [{ id: 'key-1', name: 'Key 1' }] },
    range: 'today',
    buckets: [bucket],
  });

  it('plots recorded traffic from every provider, not just the configured one', () => {
    const chart = searchChart([searchRecord('tavily', 3), searchRecord('microsoft-web-iq', 4)]);
    expect(chart.providers).toEqual(['microsoft-web-iq', 'tavily']);
    expect(chart.entries.map(entry => entry.label)).toEqual(['Key 1']);
    expect(areaPlot(chart.plot).lineChartData![0]!.data).toEqual([expect.objectContaining({ y: 7 })]);
  });
});

describe('legend weights', () => {
  const options = [{ value: 'small', label: 'Small' }, { value: 'large', label: 'Large' }];

  it('weighs a rate by the requests behind it rather than by summed percentages', () => {
    const model = buildTokenChart({
      records: [
        record({ input_tokens: '0', input_cache_read_tokens: '10' }, 'small'),
        { ...record({ input_tokens: '10' }, 'large'), requests: 7 },
      ],
      dimensionOptions: options,
      metric: 'cachedRate',
      range: 'today',
      buckets: [bucket],
    });
    expect(model.weights).toEqual(new Map([['small', 1], ['large', 7]]));
  });
});
