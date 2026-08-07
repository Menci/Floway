import { describe, expect, it, test } from 'vitest';

import { dashboardBucketKeyForUtcHour, type ChartBucket } from '../../../src/components/charts/dashboard-time';
import { buildSearchChart, buildTokenChart, summarizeCounters, summarizeUsage } from '../../../src/components/usage/plot';
import type { ChartPlot, DisplayUsageRecord } from '../../../src/components/usage/types';

const linePlot = (plot: ChartPlot) => {
  if (plot.form !== 'line') throw new Error(`expected a line plot, got ${plot.form}`);
  return plot.data;
};
const areaPlot = (plot: ChartPlot) => {
  if (plot.form !== 'area') throw new Error(`expected an area plot, got ${plot.form}`);
  return plot.data;
};

const RECORD_HOUR = '2026-07-28T04';
const bucket: ChartBucket = {
  key: dashboardBucketKeyForUtcHour('today', RECORD_HOUR),
  label: '12:00 - 13:00',
  date: new Date(`${RECORD_HOUR}:00:00.000Z`),
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
    })).toThrow('Usage overview series group is missing from dimension values: missing');
  });

  it('keeps duplicate display names as independently addressable series', () => {
    const model = buildTokenChart({
      records: [record({ input_tokens: '1' }, 'key-1'), record({ input_tokens: '2' }, 'key-2')],
      dimensionOptions: [{ value: 'key-1', label: 'Shared name' }, { value: 'key-2', label: 'Shared name' }],
      metric: 'total',
      range: 'today',
      buckets: [bucket],
    });

    expect(model.entries.map(entry => entry.label)).toEqual(['Shared name', 'Shared name']);
    expect(model.entries.map(entry => entry.id)).toEqual(['key-1', 'key-2']);
    expect(areaPlot(model.plot).lineChartData?.map(series => series.legend)).toEqual(['Shared name (1)', 'Shared name (2)']);
  });

  it('uses the server dimension options for nullable and deleted upstream labels', () => {
    const model = buildTokenChart({
      records: [record({ input_tokens: '1' }, 'upstream:up-1'), record({ input_tokens: '2' }, 'upstream:up-deleted'), record({ input_tokens: '3' }, 'none')],
      dimensionOptions: [
        { value: 'upstream:up-1', label: 'Copilot seat' },
        { value: 'none', label: 'Unknown upstream' },
        { value: 'upstream:up-deleted', label: 'up-deleted' },
      ],
      metric: 'total',
      range: 'today',
      buckets: [bucket],
    });

    expect(model.entries.map(entry => [entry.id, entry.label])).toEqual([
      ['upstream:up-1', 'Copilot seat'],
      ['none', 'Unknown upstream'],
      ['upstream:up-deleted', 'up-deleted'],
    ]);
  });

  it('uses configured hues for known upstream series and palette hues for historical series', () => {
    const model = buildTokenChart({
      records: [record({ input_tokens: '1' }, 'upstream:up-1'), record({ input_tokens: '2' }, 'upstream:up-deleted')],
      dimensionOptions: [
        { value: 'upstream:up-1', label: 'Copilot seat' },
        { value: 'upstream:up-deleted', label: 'up-deleted' },
      ],
      metric: 'total',
      range: 'today',
      buckets: [bucket],
      seriesHues: new Map([['upstream:up-1', 217]]),
    });

    expect(model.entries.map(entry => entry.hue)).toEqual([217, 144]);
    expect(areaPlot(model.plot).lineChartData?.map(series => series.color)).toEqual([
      'oklch(0.7 0.13 217)',
      'oklch(0.7 0.13 144)',
    ]);
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

  it('reports the same totals the summary tiles do', () => {
    expect(summarizeCounters(counters)).toEqual(summarizeUsage([record(metrics)]));
  });
});

test('repeated local hours remain independent chart points', () => {
  const buckets = ['2026-11-01T05', '2026-11-01T06'].map(hour => ({
    key: hour,
    label: '01:00',
    date: new Date(`${hour}:00:00.000Z`),
  }));
  const records = buckets.map(({ key }, index) => ({
    bucket: key,
    group: 'key-1',
    requests: 1,
    metrics: { input_tokens: index === 0 ? '1' : '2' },
    cost: null,
  } satisfies DisplayUsageRecord));

  const model = buildTokenChart({
    records,
    dimensionOptions: [{ value: 'key-1', label: 'Key 1' }],
    metric: 'total',
    range: 'today',
    buckets,
  });

  expect(areaPlot(model.plot).lineChartData![0]!.data.map(point => point.y)).toEqual([1, 2]);
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

  it('reports no series when the window holds no search traffic', () => {
    expect(searchChart([]).entries).toEqual([]);
  });

  it('ignores records that fall outside the plotted window', () => {
    const chart = searchChart([{ ...searchRecord('tavily', 5), hour: '2026-07-20T04' }]);
    expect(chart.entries).toEqual([]);
    expect(chart.providers).toEqual([]);
  });
});
