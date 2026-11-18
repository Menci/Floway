import { describe, expect, it } from 'vitest';

import { legacyRedirectTarget } from '../../src/lib/legacy-redirects';

describe('legacy dashboard route redirects', () => {
  it.each([
    ['/dashboard/keys', '/dashboard/services/api-keys'],
    ['/dashboard/upstreams/new', '/dashboard/providers/upstreams'],
  ])('redirects %s to %s', (from, to) => {
    expect(legacyRedirectTarget(from)).toBe(to);
  });

  it('preserves a legacy request record hash as the record search param', () => {
    expect(legacyRedirectTarget('/dashboard/requests/key-123', '#record-9')).toBe('/dashboard/monitor/requests?key=key-123&record=record-9');
    expect(legacyRedirectTarget('/dashboard/requests/key-123', '#record%209')).toBe('/dashboard/monitor/requests?key=key-123&record=record%209');
  });
});
