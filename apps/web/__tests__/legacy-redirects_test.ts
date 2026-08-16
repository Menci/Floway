import { describe, expect, it } from 'vitest';

import { clientLoader } from '../src/routes/legacy-redirects';

const redirectTarget = async (path: string, params: Record<string, string> = {}, hash = '') => {
  window.history.replaceState({}, '', `${path}${hash}`);
  const request = new Request(`http://floway.test${path}`);
  try {
    await clientLoader({ params, request } as unknown as Parameters<typeof clientLoader>[0]);
    return null;
  } catch (error) {
    if (error instanceof Response && error.status === 302) return error.headers.get('Location');
    throw error;
  }
};

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
  ])('redirects %s to %s', async (from, to) => {
    await expect(redirectTarget(from)).resolves.toBe(to);
  });

  it('redirects a legacy request key to the requests monitor key search param', async () => {
    await expect(redirectTarget('/dashboard/requests/key-123', { keyId: 'key-123' })).resolves
      .toBe('/dashboard/monitor/requests?key=key-123');
  });

  it('preserves a legacy request record hash as the record search param', async () => {
    await expect(redirectTarget('/dashboard/requests/key-123', { keyId: 'key-123' }, '#record-9')).resolves
      .toBe('/dashboard/monitor/requests?key=key-123&record=record-9');
    await expect(redirectTarget('/dashboard/requests/key-123', { keyId: 'key-123' }, '#record%209')).resolves
      .toBe('/dashboard/monitor/requests?key=key-123&record=record%209');
  });

  it('redirects legacy upstream routes to the provider upstream routes', async () => {
    await expect(redirectTarget('/dashboard/upstreams/up_abc', { id: 'up_abc' })).resolves
      .toBe('/dashboard/providers/upstreams/up_abc');
    await expect(redirectTarget('/dashboard/upstreams/new/custom', { provider: 'custom' })).resolves
      .toBe('/dashboard/providers/upstreams/new/custom');
  });

  it('encodes path params and record hashes in the redirect target', async () => {
    await expect(redirectTarget('/dashboard/requests/key%201', { keyId: 'key 1' })).resolves
      .toBe('/dashboard/monitor/requests?key=key%201');
    await expect(redirectTarget('/dashboard/upstreams/new/a%2Fb', { provider: 'a/b' })).resolves
      .toBe('/dashboard/providers/upstreams/new/a%2Fb');
  });
});
