import { describe, expect, it } from 'vitest';

import { legacyRedirectTarget } from '../src/lib/legacy-redirects';

describe('legacy dashboard route redirects', () => {
  it.each([
    ['/login', '/'],
    ['/dashboard/keys', '/dashboard/services/api-keys'],
    ['/dashboard/models', '/dashboard/playground'],
    ['/dashboard/performance', '/dashboard/monitor/performance'],
    ['/dashboard/requests', '/dashboard/monitor/requests'],
    ['/dashboard/upstreams', '/dashboard/providers/upstreams'],
    ['/dashboard/upstreams/new', '/dashboard/providers/upstreams'],
    ['/dashboard/usage', '/dashboard/monitor/usage'],
    ['/dashboard/users', '/dashboard/admin/users'],
  ])('redirects %s to %s', (from, to) => {
    expect(legacyRedirectTarget(from)).toBe(to);
  });

  it('redirects a legacy request key to the requests monitor key search param', () => {
    expect(legacyRedirectTarget('/dashboard/requests/key-123')).toBe('/dashboard/monitor/requests?key=key-123');
  });

  it('preserves a legacy request record hash as the record search param', () => {
    expect(legacyRedirectTarget('/dashboard/requests/key-123', '#record-9')).toBe('/dashboard/monitor/requests?key=key-123&record=record-9');
    expect(legacyRedirectTarget('/dashboard/requests/key-123', '#record%209')).toBe('/dashboard/monitor/requests?key=key-123&record=record%209');
  });

  it('redirects legacy upstream routes to the provider upstream routes', () => {
    expect(legacyRedirectTarget('/dashboard/upstreams/up_abc')).toBe('/dashboard/providers/upstreams/up_abc');
    expect(legacyRedirectTarget('/dashboard/upstreams/new/custom')).toBe('/dashboard/providers/upstreams/new/custom');
  });

  it('encodes path params and record hashes in the redirect target', () => {
    expect(legacyRedirectTarget('/dashboard/requests/key%201')).toBe('/dashboard/monitor/requests?key=key%201');
    expect(legacyRedirectTarget('/dashboard/upstreams/new/a%2Fb')).toBe('/dashboard/providers/upstreams/new/a%2Fb');
  });

  it('treats trailing slashes as the same legacy route', () => {
    expect(legacyRedirectTarget('/login/')).toBe('/');
    expect(legacyRedirectTarget('/dashboard/keys/')).toBe('/dashboard/services/api-keys');
    expect(legacyRedirectTarget('/dashboard/requests/key-123/')).toBe('/dashboard/monitor/requests?key=key-123');
  });

  it('returns null for paths that are not legacy routes', () => {
    expect(legacyRedirectTarget('/dashboard/settings')).toBeNull();
    expect(legacyRedirectTarget('/dashboard/unknown')).toBeNull();
    expect(legacyRedirectTarget('/')).toBeNull();
  });
});
