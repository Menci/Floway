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

  it('clears both identity filters when grouping by user or API key', () => {
    expect(parseUsageUrlState(new URLSearchParams('g=userId&fusr=2&fk=key-1')).filters).toMatchObject({ userId: [], keyId: [] });
    expect(parseUsageUrlState(new URLSearchParams('g=keyId&fusr=2&fk=key-1')).filters).toMatchObject({ userId: [], keyId: [] });
  });
});
