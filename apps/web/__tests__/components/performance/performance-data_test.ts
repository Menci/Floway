import { describe, expect, it } from 'vitest';

import { buildPerformanceQuery, clearGroupedFilter, emptyPerformanceFilters, parsePerformanceUrlState, performanceValue, serializePerformanceUrlState } from '../../../src/components/performance/performance-data';

describe('performance overview query', () => {
  it('sends group-by and all active filters using the new API shape', () => {
    const search = buildPerformanceQuery('all-by-user', '7d', 'operation', {
      model: 'gpt-5', upstream: 'up_1', operation: '', runtimeLocation: 'SJC', userId: '2', keyId: 'key_1',
    }, Date.UTC(2026, 6, 12, 4));
    expect(search.get('group_by')).toBe('operation');
    expect(search.get('filter_model')).toBe('gpt-5');
    expect(search.get('filter_upstream')).toBe('up_1');
    expect(search.get('filter_runtime_location')).toBe('SJC');
    expect(search.get('filter_user_id')).toBe('2');
    expect(search.get('filter_key_id')).toBe('key_1');
    expect(search.has('metric_scope')).toBe(false);
  });

  it('converts TPOT microseconds to output tokens per second', () => {
    const record = { tpotUsP95: 20_000 } as Parameters<typeof performanceValue>[0];
    expect(performanceValue(record, 'tokPerSec', 'p95')).toBe(50);
  });

  it('clears filters hidden by the selected grouping', () => {
    const filters = { ...emptyPerformanceFilters(), userId: '2', keyId: 'key_1' };
    expect(clearGroupedFilter(filters, 'userId')).toMatchObject({ userId: '', keyId: '' });
  });

  it('round-trips non-default dashboard state through the URL', () => {
    const state = parsePerformanceUrlState(new URLSearchParams('m=tokPerSec&pct=p99&g=upstream&r=30d&fm=gpt-5&hide=a%252Cb,c'));
    expect(state).toMatchObject({ metric: 'tokPerSec', percentile: 'p99', groupBy: 'upstream', range: '30d', filters: { model: 'gpt-5' }, hidden: ['a,b', 'c'] });
    expect(serializePerformanceUrlState(state).get('m')).toBe('tokPerSec');
    expect(serializePerformanceUrlState(state).get('fm')).toBe('gpt-5');
  });
});
