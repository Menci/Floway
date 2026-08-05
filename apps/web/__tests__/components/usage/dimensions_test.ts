import { describe, expect, it } from 'vitest';

import { upstreamFromUsageValue, usageUpstreamValue } from '../../../src/components/usage/dimensions';

describe('usage dimensions', () => {
  it('uses an unambiguous wire value for nullable upstreams', () => {
    expect(usageUpstreamValue(null)).toBe('none');
    expect(usageUpstreamValue('none')).toBe('upstream:none');
    expect(upstreamFromUsageValue('none')).toBeNull();
    expect(upstreamFromUsageValue('upstream:none')).toBe('none');
  });
});
