import { describe, expect, it } from 'vitest';

import { buildPerformanceQuery } from '../../../src/components/performance/data';
import { normalizePerformanceBreakdownForRuntime, normalizePerformanceDimensionsForRuntime, parsePerformanceUrlState, performanceLabels, serializePerformanceUrlState, type PerformanceDisplayRecord, type PerformanceOverviewView } from '../../../src/components/performance/overview';
import { buildPerformanceChart } from '../../../src/components/performance/plot';

const emptyOverview = (): PerformanceOverviewView => ({
  series: [],
  rows: [], summary: null,
  dimensionValues: { models: [], upstreams: [], operations: [], runtimeLocations: [], keyIds: [], userIds: [] },
  users: [],
  upstreams: [],
  keys: [],
});

describe('performance overview query', () => {
  it('requests fixed-width Performance buckets at the dashboard granularity', () => {
    const filters = { model: [], upstream: [], operation: [], runtimeLocation: [], userId: [], keyId: [] };

    expect(buildPerformanceQuery({ range: 'today', groupBy: 'model', filters }, 'model', Date.UTC(2026, 10, 1, 7))).toMatchObject({
      bucket: 'hour', format: 'buckets', dimension: 'model',
    });
    expect(buildPerformanceQuery({ range: '30d', groupBy: 'model', filters }, 'model', Date.UTC(2026, 10, 1, 7)).bucket).toBe('day');
  });

  it('round-trips non-default dashboard state through the URL', () => {
    const state = parsePerformanceUrlState(new URLSearchParams('m=tokPerSec&ttft_p=p99&speed_p=p50&tab=upstream&sort=errors&dir=ascending&g=upstream&r=30d&fm=&fm=gpt-5&fm=gpt-5&fm=claude-opus-4-7&hide=a%252Cb,c'));
    const serialized = serializePerformanceUrlState({ ...state, hidden: ['a,b', '100%', '模型', 'duplicate', 'duplicate'] });
    expect(parsePerformanceUrlState(serialized)).toMatchObject({
      metric: 'tokPerSec',
      percentile: 'p50',
      breakdown: 'upstream',
      sort: { key: 'errors', direction: 'ascending' },
      groupBy: 'upstream',
      range: '30d',
      filters: { model: ['gpt-5', 'claude-opus-4-7'] },
      hidden: ['100%', 'a,b', 'duplicate', 'duplicate', '模型'],
    });
    expect(serialized.get('m')).toBe('tokPerSec');
    expect(serialized.get('p')).toBe('p50');
    expect(serialized.has('ttft_p')).toBe(false);
    expect(serialized.has('speed_p')).toBe(false);
    expect(serialized.get('tab')).toBe('upstream');
    expect(serialized.get('sort')).toBe('errors');
    expect(serialized.get('dir')).toBe('ascending');
    expect(serialized.getAll('fm')).toEqual(['gpt-5', 'claude-opus-4-7']);
  });

  it.each([
    ['', 'p95'], ['p=p50', 'p50'], ['p=p95', 'p95'], ['p=p99', 'p99'],
    ['ttft_p=p99&speed_p=p50', 'p99'],
    ['m=tokPerSec&ttft_p=p99&speed_p=p50', 'p50'],
    ['m=invalid&ttft_p=p99&speed_p=p50', 'p99'],
    ['speed_p=p50', 'p95'], ['m=tokPerSec&ttft_p=p99', 'p95'],
    ['ttft_p=invalid&speed_p=p50', 'p95'],
    ['m=tokPerSec&speed_p=invalid&ttft_p=p99', 'p95'],
    ['p=p99&ttft_p=p50&speed_p=p50', 'p99'],
    ['m=tokPerSec&p=p95&ttft_p=p99&speed_p=p50', 'p95'],
    ['p=&ttft_p=p99', 'p95'], ['p=invalid&ttft_p=p99', 'p95'],
  ])('normalizes shared and legacy percentile links: %s', (search, percentile) => {
    const state = parsePerformanceUrlState(new URLSearchParams(search));
    const serialized = serializePerformanceUrlState(state);

    expect(state.percentile).toBe(percentile);
    expect(serialized.get('p')).toBe(percentile === 'p95' ? null : percentile);
    expect(serialized.has('ttft_p')).toBe(false);
    expect(serialized.has('speed_p')).toBe(false);
    expect(parsePerformanceUrlState(serialized)).toEqual(state);
  });

  it('removes Region state outside the Cloudflare runtime', () => {
    const state = parsePerformanceUrlState(new URLSearchParams('g=runtimeLocation&tab=runtimeLocation&fm=gpt-5&fr=SJC&hide=SJC'));
    expect(normalizePerformanceDimensionsForRuntime(state, false)).toMatchObject({
      changed: true,
      state: {
        groupBy: 'model',
        filters: { model: [], runtimeLocation: [] },
        hidden: [],
      },
    });
    expect(normalizePerformanceDimensionsForRuntime(state, true)).toEqual({ changed: false, state });
    expect(normalizePerformanceBreakdownForRuntime(state.breakdown, false)).toBe('model');
    expect(normalizePerformanceBreakdownForRuntime(state.breakdown, true)).toBe(state.breakdown);
  });
});

describe('performance chart series', () => {
  const record = (group: string): PerformanceDisplayRecord => ({
    bucket: 'bucket-1',
    group,
    requests: 1,
    errors: 0,
    ttftSamples: 1,
    tpotSamples: 1,
    neutral: 0,
    ttftMsP50: 10,
    ttftMsP95: 20,
    ttftMsP99: 30,
    tpotUsP50: 10_000,
    tpotUsP95: 20_000,
    tpotUsP99: 30_000,
  });
  const buckets = [{ key: 'bucket-1', label: 'Bucket 1', date: new Date(0), start: 0, end: 3_600_000 }];

  it.each(['ttft', 'tokPerSec'] as const)('uses one percentile for the %s curve and both hover values', metric => {
    const labels = performanceLabels(emptyOverview(), []);
    for (const [percentile, ttft, outputSpeed] of [['p50', 10, 100], ['p95', 20, 50], ['p99', 30, 1_000_000 / 30_000]] as const) {
      const chart = buildPerformanceChart([record('model-a')], metric, percentile, 'model', labels, buckets, 'today');
      expect(chart.data.lineChartData?.[0].data).toEqual([expect.objectContaining({ x: new Date(0), y: metric === 'ttft' ? ttft : outputSpeed })]);
      expect(chart.details.get(0)?.get('model-a')).toEqual({ ttft, outputSpeed });
    }
  });

  it.each([null, 0, -1])('keeps missing or invalid speed readings out of the curve: %s', tpot => {
    const labels = performanceLabels(emptyOverview(), []);
    const row = { ...record('model-a'), ttftMsP50: null, ttftMsP95: null, ttftMsP99: null, tpotUsP50: tpot, tpotUsP95: tpot, tpotUsP99: tpot };
    for (const percentile of ['p50', 'p95', 'p99'] as const) {
      const chart = buildPerformanceChart([row], 'tokPerSec', percentile, 'model', labels, buckets, 'today');
      expect(chart.data.lineChartData).toEqual([]);
      expect(chart.details.get(0)?.get('model-a')).toEqual({ ttft: null, outputSpeed: null });
    }
  });

  it('uses stable group ids when two API keys have the same name', () => {
    const overview = emptyOverview();
    overview.keys = [
      { id: 'key-1', name: 'Shared name', createdAt: '' },
      { id: 'key-2', name: 'Shared name', createdAt: '' },
    ];
    const chart = buildPerformanceChart(
      [record('key-1'), record('key-2')],
      'ttft',
      'p95',
      'keyId',
      performanceLabels(overview, []),
      buckets,
      'today',
    );

    expect(chart.entries.map(entry => entry.label)).toEqual(['Shared name', 'Shared name']);
    expect(chart.entries.map(entry => entry.id)).toEqual(['key-1', 'key-2']);
    expect(chart.data.lineChartData?.map(series => series.legend)).toEqual(['Shared name (1)', 'Shared name (2)']);
    expect(chart.details.get(0)?.get('key-1')).toEqual({ outputSpeed: 50, ttft: 20 });
  });
});
