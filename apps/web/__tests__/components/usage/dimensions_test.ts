import { describe, expect, it } from 'vitest';

import { clearGroupedUsageFilter, upstreamFromUsageValue, usageUpstreamValue } from '../../../src/components/usage/dimensions';

const filters = {
  model: ['gpt-5'],
  upstream: ['upstream:up-1'],
  userId: ['2'],
  keyId: ['key-1'],
};

describe('usage dimensions', () => {
  it('uses an unambiguous wire value for nullable upstreams', () => {
    expect(usageUpstreamValue(null)).toBe('none');
    expect(usageUpstreamValue('none')).toBe('upstream:none');
    expect(upstreamFromUsageValue('none')).toBeNull();
    expect(upstreamFromUsageValue('upstream:none')).toBe('none');
  });

  it('clears only a non-identity grouping filter', () => {
    expect(clearGroupedUsageFilter(filters, 'model')).toEqual({ ...filters, model: [] });
  });

  it('clears user and API key filters together for either identity grouping', () => {
    expect(clearGroupedUsageFilter(filters, 'userId')).toEqual({ ...filters, userId: [], keyId: [] });
    expect(clearGroupedUsageFilter(filters, 'keyId')).toEqual({ ...filters, userId: [], keyId: [] });
  });
});
