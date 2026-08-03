import { describe, expect, it } from 'vitest';

import { dashboardBucketKeyForUtcHour, type ChartBucket } from '../../../src/components/charts/dashboard-time';
import { buildSearchChart, buildTokenChart, summarizeCounters, summarizeUsage } from '../../../src/components/usage/plot';
import type { ChartPlot, DisplayUsageRecord } from '../../../src/components/usage/types';

// Narrow a plot to the form the assertion is about, failing loudly rather than
// silently asserting nothing when a chart switches form.
const linePlot = (plot: ChartPlot) => {
  if (plot.form !== 'line') throw new Error(`expected a line plot, got ${plot.form}`);
  return plot.data;
};
const areaPlot = (plot: ChartPlot) => {
  if (plot.form !== 'area') throw new Error(`expected an area plot, got ${plot.form}`);
  return plot.data;
};

// The chart buckets by local hour, so a fixture that spelled the key out would
// only line up with the record in the zone it was written in.
const RECORD_HOUR = '2026-07-28T04';

const bucket: ChartBucket = {
  key: dashboardBucketKeyForUtcHour('today', RECORD_HOUR),
  label: '12:00 - 13:00',
  date: new Date(`${RECORD_HOUR}:00:00.000Z`),
};

const record = (metrics: DisplayUsageRecord['metrics']): DisplayUsageRecord => ({
  keyId: 'key-1',
  keyName: 'Key 1',
  model: 'model-1',
  hour: RECORD_HOUR,
  requests: 1,
  metrics,
  cost: null,
});

const chart = (metrics: DisplayUsageRecord['metrics']) => buildTokenChart({
  records: [record(metrics)],
  metadata: [{ id: 'key-1', name: 'Key 1' }],
  models: [],
  groupKey: 'keyId',
  hiddenOther: new Set(),
  redactKeys: false,
  metric: 'cachedRate',
  range: 'today',
  buckets: [bucket],
});

describe('percentage chart series', () => {
  it('keeps a real zero-percent point', () => {
    expect(linePlot(chart({ input_tokens: '10', input_cache_read_tokens: '0' }).plot).lineChartData![0]!.data)
      .toEqual([expect.objectContaining({ y: 0 })]);
  });

  it('omits a percentage whose denominator does not exist', () => {
    expect(linePlot(chart({}).plot).lineChartData).toEqual([]);
  });
});

describe('cost chart series', () => {
  it('does not turn unavailable pricing into measured zero cost', () => {
    const model = buildTokenChart({
      records: [record({ input_tokens: '10' })],
      metadata: [{ id: 'key-1', name: 'Key 1' }],
      models: [],
      groupKey: 'keyId',
      hiddenOther: new Set(),
      redactKeys: false,
      metric: 'cost',
      range: 'today',
      buckets: [bucket],
    });

    // An unpriced bucket contributes no segment at all; a zero-height one would
    // read as 'nothing was spent' rather than 'no rate is on file'.
    expect(areaPlot(model.plot).lineChartData![0]!.data).toEqual([]);
  });
});

describe('redacted series labels', () => {
  it('keeps users distinct when their ids share a prefix', () => {
    const records = ['user-10', 'user-11'].map((keyId, index) => ({
      ...record({ input_tokens: String(index + 1) }),
      keyId,
    }));
    const model = buildTokenChart({
      records,
      metadata: [{ id: 'user-10', name: 'Alice' }, { id: 'user-11', name: 'Bob' }],
      models: [],
      groupKey: 'keyId',
      hiddenOther: new Set(),
      redactKeys: true,
      metric: 'total',
      range: 'today',
      buckets: [bucket],
    });
    expect(model.entries.map(entry => entry.label)).toEqual(['user-1', 'user-2']);
  });
});

describe('series identity', () => {
  it('keeps duplicate display names as independently addressable series', () => {
    const records = ['key-1', 'key-2'].map((keyId, index) => ({
      ...record({ input_tokens: String(index + 1) }),
      keyId,
      keyName: 'Shared name',
    }));
    const model = buildTokenChart({
      records,
      metadata: [{ id: 'key-1', name: 'Shared name' }, { id: 'key-2', name: 'Shared name' }],
      models: [],
      groupKey: 'keyId',
      hiddenOther: new Set(),
      redactKeys: false,
      metric: 'total',
      range: 'today',
      buckets: [bucket],
    });

    expect(model.entries.map(entry => entry.label)).toEqual(['Shared name', 'Shared name']);
    expect(model.entries.map(entry => entry.id)).toEqual(['key-1', 'key-2']);
    expect(areaPlot(model.plot).lineChartData?.map(series => series.legend)).toEqual(['Shared name (1)', 'Shared name (2)']);
  });
});

describe('bucket callout figures', () => {
  // Token counts are decimal strings, so a `+` between two of them concatenates
  // digits instead of failing to compile. Pin the arithmetic on values whose
  // concatenation is visibly distinct from their sum.
  const counters = chart({
    input_tokens: '20',
    input_cache_read_tokens: '300',
    input_cache_write_tokens: '4000',
    input_image_tokens: '50000',
    output_tokens: '600000',
    output_image_tokens: '7000000',
  }).details.get(bucket.key)!.get('key-1')!;

  it('adds the disjoint counters instead of joining them', () => {
    expect(summarizeCounters(counters)).toMatchObject({
      prompt: '54320',
      prefill: '54020',
      output: '7600000',
      total: '7654320',
    });
  });

  it('reports the same totals the summary tiles do', () => {
    expect(summarizeCounters(counters)).toEqual(summarizeUsage([record({
      input_tokens: '20',
      input_cache_read_tokens: '300',
      input_cache_write_tokens: '4000',
      input_image_tokens: '50000',
      output_tokens: '600000',
      output_image_tokens: '7000000',
    })]));
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
    redactKeys: false,
    range: 'today',
    buckets: [bucket],
  });

  it('plots recorded traffic from every provider, not just the configured one', () => {
    const chart = searchChart([searchRecord('tavily', 3), searchRecord('microsoft-web-iq', 4)]);
    expect(chart.providers).toEqual(['microsoft-web-iq', 'tavily']);
    expect(areaPlot(chart.plot).lineChartData![0]!.data).toEqual([expect.objectContaining({ y: 7 })]);
  });

  it('reports no series when the window holds no search traffic', () => {
    expect(searchChart([]).entries).toEqual([]);
  });

  it('ignores records that fall outside the plotted window', () => {
    const chart = searchChart([{ ...searchRecord('tavily', 5), hour: '2026-07-20T04' }]);
    expect(chart.entries).toEqual([]);
    expect(chart.providers).toEqual([]);
  });
});
