import { describe, expect, it } from 'vitest';

import { buildPerformanceQuery, clearGroupedFilter, parsePerformanceUrlState, performanceLabels, performanceValue, serializePerformanceUrlState, type PerformanceDisplayRecord, type PerformanceOverviewResponse } from '../../../src/components/performance/overview';
import { buildPerformanceChart } from '../../../src/components/performance/plot';

const emptyOverview = (): PerformanceOverviewResponse => ({
  series: [],
  axes: { none: [], keyId: [], userId: [], model: [], upstream: [], operation: [], runtimeLocation: [] },
  dimensionValues: { models: [], upstreams: [], operations: [], runtimeLocations: [], keyIds: [], userIds: [] },
  users: [],
  keys: [],
});

describe('performance overview query', () => {
  it('sends group-by and all active filters using the new API shape', () => {
    const query = buildPerformanceQuery('7d', 'operation', {
      model: ['gpt-5', 'claude-opus-4-7'], upstream: ['up_1'], operation: [], runtimeLocation: ['SJC'], userId: ['2'], keyId: ['key_1'],
    }, Date.UTC(2026, 6, 12, 4));
    expect(query).toMatchObject({
      group_by: 'operation',
      filter_model: ['gpt-5', 'claude-opus-4-7'],
      filter_upstream: ['up_1'],
      filter_runtime_location: ['SJC'],
      filter_user_id: ['2'],
      filter_key_id: ['key_1'],
    });
    expect(query).not.toHaveProperty('metric_scope');
  });

  it('converts TPOT microseconds to output tokens per second', () => {
    const record = { tpotUsP95: 20_000 } as Parameters<typeof performanceValue>[0];
    expect(performanceValue(record, 'tokPerSec', 'p95')).toBe(50);
  });

  it('clears filters hidden by the selected grouping', () => {
    const filters = { model: [], upstream: [], operation: [], runtimeLocation: [], userId: ['2'], keyId: ['key_1'] };
    expect(clearGroupedFilter(filters, 'userId')).toMatchObject({ userId: [], keyId: [] });
  });

  it('round-trips non-default dashboard state through the URL', () => {
    const state = parsePerformanceUrlState(new URLSearchParams('m=tokPerSec&pct=p99&g=upstream&r=30d&fm=&fm=gpt-5&fm=gpt-5&fm=claude-opus-4-7&hide=a%252Cb,c'));
    const serialized = serializePerformanceUrlState({ ...state, hidden: ['a,b', '100%', '模型', 'duplicate', 'duplicate'] });
    expect(parsePerformanceUrlState(serialized)).toMatchObject({
      metric: 'tokPerSec',
      percentile: 'p99',
      groupBy: 'upstream',
      range: '30d',
      filters: { model: ['gpt-5', 'claude-opus-4-7'] },
      hidden: ['100%', 'a,b', 'duplicate', 'duplicate', '模型'],
    });
    expect(serialized.get('m')).toBe('tokPerSec');
    expect(serialized.getAll('fm')).toEqual(['gpt-5', 'claude-opus-4-7']);
  });

  it('restores hidden series from the original comma format', () => {
    expect(parsePerformanceUrlState(new URLSearchParams('hide=a%252Cb,c')).hidden).toEqual(['a,b', 'c']);
  });

  it('distinguishes one comma-containing id in the repeated parameter format', () => {
    const state = parsePerformanceUrlState(new URLSearchParams());
    const serialized = serializePerformanceUrlState({ ...state, hidden: ['a,b'] });

    expect(serialized.get('hidev')).toBe('2');
    expect(serialized.getAll('hide')).toEqual(['a,b']);
    expect(parsePerformanceUrlState(serialized).hidden).toEqual(['a,b']);
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
});

describe('performance chart series', () => {
  it('uses stable group ids when two API keys have the same name', () => {
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
      performanceLabels(overview, new Map()),
      [{ key: 'bucket-1', label: 'Bucket 1', date: new Date(0) }],
      'today',
    );

    expect(chart.entries.map(entry => entry.label)).toEqual(['Shared name', 'Shared name']);
    expect(chart.entries.map(entry => entry.id)).toEqual(['key-1', 'key-2']);
    expect(chart.data.lineChartData?.map(series => series.legend)).toEqual(['Shared name (1)', 'Shared name (2)']);
    expect(chart.details.get(0)?.get('key-1')).toEqual({ outputSpeed: 50, ttft: 20 });
  });
});
