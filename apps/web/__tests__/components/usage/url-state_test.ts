import { describe, expect, it } from 'vitest';

import { parseUsageUrlState, serializeUsageUrlState } from '../../../src/components/usage/url-state';

describe('usage URL state', () => {
  it('matches Performance grouping and repeated-filter parameters', () => {
    const state = parseUsageUrlState(new URLSearchParams('r=7d&m=cost&g=upstream&fk=&fk=key-1&fk=key-1&fm=gpt-5&fu=upstream%3Aup-1&fusr=2&hide=upstream%253Aup-2&hideSearch=user-2'));

    expect(state).toEqual({
      range: '7d',
      metric: 'cost',
      groupBy: 'upstream',
      filters: { keyId: ['key-1'], userId: ['2'], model: ['gpt-5'], upstream: [] },
      hidden: ['upstream:up-2'],
      hiddenSearch: ['user-2'],
    });
    const serialized = serializeUsageUrlState(state);
    expect(serialized.get('g')).toBe('upstream');
    expect(serialized.getAll('fk')).toEqual(['key-1']);
    expect(serialized.getAll('fu')).toEqual([]);
  });

  it('preserves the user scope for API key grouping until the loader resolves the current user', () => {
    expect(parseUsageUrlState(new URLSearchParams('g=userId&fusr=2&fk=key-1')).filters).toMatchObject({ userId: [], keyId: [] });
    expect(parseUsageUrlState(new URLSearchParams('g=keyId&fusr=2&fk=key-1')).filters).toMatchObject({ userId: ['2'], keyId: [] });
  });

  it('uses the shared opaque hidden-series format for both charts', () => {
    const state = parseUsageUrlState(new URLSearchParams());
    const serialized = serializeUsageUrlState({
      ...state,
      hidden: ['模型', '100%', 'a,b', 'duplicate', 'duplicate'],
      hiddenSearch: ['search,series', '100%'],
    });

    expect(serialized.get('hidev')).toBe('2');
    expect(serialized.get('hideSearchv')).toBe('2');
    expect(parseUsageUrlState(serialized)).toMatchObject({
      hidden: ['100%', 'a,b', 'duplicate', 'duplicate', '模型'],
      hiddenSearch: ['100%', 'search,series'],
    });
  });
});
