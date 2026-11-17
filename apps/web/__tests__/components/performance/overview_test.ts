import { describe, expect, it } from 'vitest';

import { buildPerformanceQuery, normalizePerformanceBreakdownForRuntime, normalizePerformanceDimensionsForRuntime, parsePerformanceUrlState, performanceLabels, performanceValue, serializePerformanceUrlState, type PerformanceDisplayRecord, type PerformanceOverviewResponse } from '../../../src/components/performance/overview';
import { buildPerformanceChart } from '../../../src/components/performance/plot';

const emptyOverview = (): PerformanceOverviewResponse => ({
  series: [],
  axes: { none: [], keyId: [], userId: [], model: [], upstream: [], operation: [], runtimeLocation: [] },
  dimensionValues: { models: [], upstreams: [], operations: [], runtimeLocations: [], keyIds: [], userIds: [] },
  users: [],
  upstreams: [],
  keys: [],
});

describe('performance overview query', () => {
  it('sends group-by and all active filters', () => {
    const query = buildPerformanceQuery('7d', 'operation', {
      model: ['gpt-5', 'claude-opus-4-7'], upstream: ['up_1'], operation: [], runtimeLocation: ['SJC'], userId: ['2'], keyId: ['key_1'],
    }, Date.UTC(2026, 6, 12, 4));
    expect(query).toMatchObject({
      bucket: '4h',
      group_by: 'operation',
      filter_model: ['gpt-5', 'claude-opus-4-7'],
      filter_upstream: ['up_1'],
      filter_runtime_location: ['SJC'],
      filter_user_id: ['2'],
      filter_key_id: ['key_1'],
    });
  });

  it('requests UTC hours only for the range whose repeated hours stay separate', () => {
    const filters = { model: [], upstream: [], operation: [], runtimeLocation: [], userId: [], keyId: [] };

    expect(buildPerformanceQuery('today', 'model', filters, Date.UTC(2026, 10, 1, 7))).toMatchObject({
      bucket: 'hour',
      timezone: 'UTC',
      timezone_offset_minutes: '0',
    });
    expect(buildPerformanceQuery('30d', 'model', filters, Date.UTC(2026, 10, 1, 7)).bucket).toBe('day');
  });

  it('reads the percentile it is given, so each table column can carry its own', () => {
    const record = { ttftMsP50: 100, ttftMsP99: 300, tpotUsP50: 10_000, tpotUsP99: 40_000 } as Parameters<typeof performanceValue>[0];

    expect(performanceValue(record, 'ttft', 'p50')).toBe(100);
    expect(performanceValue(record, 'ttft', 'p99')).toBe(300);
    expect(performanceValue(record, 'tokPerSec', 'p50')).toBe(100);
    expect(performanceValue(record, 'tokPerSec', 'p99')).toBe(25);
  });

  it('round-trips non-default dashboard state through the URL', () => {
    const state = parsePerformanceUrlState(new URLSearchParams('m=tokPerSec&ttft_p=p99&speed_p=p50&tab=upstream&sort=errors&dir=ascending&g=upstream&r=30d&fm=&fm=gpt-5&fm=gpt-5&fm=claude-opus-4-7&hide=a%252Cb,c'));
    const serialized = serializePerformanceUrlState({ ...state, hidden: ['a,b', '100%', '模型', 'duplicate', 'duplicate'] });
    expect(parsePerformanceUrlState(serialized)).toMatchObject({
      metric: 'tokPerSec',
      percentiles: { ttft: 'p99', tokPerSec: 'p50' },
      breakdown: 'upstream',
      sort: { key: 'errors', direction: 'ascending' },
      groupBy: 'upstream',
      range: '30d',
      filters: { model: ['gpt-5', 'claude-opus-4-7'] },
      hidden: ['100%', 'a,b', 'duplicate', 'duplicate', '模型'],
    });
    expect(serialized.get('m')).toBe('tokPerSec');
    expect(serialized.get('ttft_p')).toBe('p99');
    expect(serialized.get('speed_p')).toBe('p50');
    expect(serialized.get('tab')).toBe('upstream');
    expect(serialized.get('sort')).toBe('errors');
    expect(serialized.get('dir')).toBe('ascending');
    expect(serialized.getAll('fm')).toEqual(['gpt-5', 'claude-opus-4-7']);
  });

  it('omits a default sort and direction from the URL', () => {
    const state = parsePerformanceUrlState(new URLSearchParams());

    expect(state.sort).toEqual({ key: 'requests', direction: 'descending' });
    expect(serializePerformanceUrlState(state).toString()).toBe('');
  });

  it('restores hidden series from the original comma format', () => {
    expect(parsePerformanceUrlState(new URLSearchParams('hide=a%252Cb,c')).hidden).toEqual(['a,b', 'c']);
  });

  it('serializes hidden series as stable repeated parameters', () => {
    const state = parsePerformanceUrlState(new URLSearchParams());
    const first = serializePerformanceUrlState({ ...state, hidden: ['模型', 'duplicate', '100%', 'a,b', 'duplicate'] });
    const second = serializePerformanceUrlState({ ...state, hidden: ['duplicate', 'a,b', '模型', '100%', 'duplicate'] });

    expect(first.toString()).toBe(second.toString());
    expect(first.get('hidev')).toBe('2');
    expect(first.getAll('hide')).toEqual(['100%', 'a,b', 'duplicate', 'duplicate', '模型']);
    expect(parsePerformanceUrlState(first).hidden).toEqual(['100%', 'a,b', 'duplicate', 'duplicate', '模型']);
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

  it('uses stable group ids when two API keys have the same name', () => {
    const overview = emptyOverview();
    overview.keys = [
      { id: 'key-1', name: 'Shared name', createdAt: '' },
      { id: 'key-2', name: 'Shared name', createdAt: '' },
    ];
    const chart = buildPerformanceChart(
      [record('key-1'), record('key-2')],
      'ttft',
      { ttft: 'p95', tokPerSec: 'p95' },
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
