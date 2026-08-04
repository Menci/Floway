import { describe, expect, it } from 'vitest';

import { parseUsageUrlState, serializeUsageUrlState } from '../../../src/components/usage/url-state';

describe('usage URL state', () => {
  it('round-trips grouping, multiselect filters, and per-dimension hidden series', () => {
    const state = parseUsageUrlState(new URLSearchParams('view=self-by-key&range=7d&metric=cost&group=upstream&filterKey=&filterKey=key-1&filterKey=key-1&filterModel=gpt-5&filterUpstream=upstream%3Aup-1&hideUpstream=upstream%3Aup-2'));

    expect(state).toMatchObject({
      view: 'self-by-key',
      range: '7d',
      metric: 'cost',
      groupBy: 'upstream',
      filters: { identity: ['key-1'], model: ['gpt-5'], upstream: ['upstream:up-1'] },
      hiddenUpstreams: ['upstream:up-2'],
    });
    const serialized = serializeUsageUrlState(state);
    expect(serialized.get('group')).toBe('upstream');
    expect(serialized.getAll('filterKey')).toEqual(['key-1']);
    expect(serialized.getAll('filterUpstream')).toEqual(['upstream:up-1']);
  });
});
