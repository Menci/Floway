import { afterEach, describe, expect, it, vi } from 'vitest';

import { clientLoader } from '../../src/routes/dashboard-monitor-performance';
import { useAuthStore } from '../../src/stores/auth-store';
import { stubLocalStorage } from '../local-storage-stub';

stubLocalStorage();

afterEach(() => {
  useAuthStore.getState().clear();
  vi.unstubAllGlobals();
});

const gatewayForOperator = (input: RequestInfo | URL) => {
  const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost').pathname;
  if (path === '/api/runtime-info') return Promise.resolve(Response.json({ kind: 'node', runtimeLocation: 'LOCAL' }));
  return Promise.resolve(Response.json({
    series: [], axes: { none: [], model: [], upstream: [], operation: [], runtimeLocation: [], keyId: [], userId: [] },
    dimensionValues: { models: [], upstreams: [], operations: [], runtimeLocations: [], userIds: [], keyIds: [] },
    users: [], upstreams: [{ id: 'up-1', name: 'Copilot seat', hue: 210 }], keys: [],
  }));
};

describe('performance overview metadata', () => {
  it('reads upstream names from the ACL-scoped overview response', async () => {
    useAuthStore.getState().primeFromLogin({ token: 'operator-session', user: { id: 2, username: 'operator', isAdmin: false, canViewUpstreams: false } });
    vi.stubGlobal('fetch', vi.fn(gatewayForOperator));

    const data = await clientLoader({ request: new Request('http://localhost/dashboard/monitor/performance') } as never);

    expect(data.overview?.upstreams).toEqual([{ id: 'up-1', name: 'Copilot seat', hue: 210 }]);
    expect(data.error).toBeNull();
  });

  it('keeps User grouping for a non-admin operator', async () => {
    useAuthStore.getState().primeFromLogin({ token: 'operator-session', user: { id: 2, username: 'operator', isAdmin: false, canViewUpstreams: false } });
    vi.stubGlobal('fetch', vi.fn(gatewayForOperator));

    const data = await clientLoader({ request: new Request('http://localhost/dashboard/monitor/performance?g=userId') } as never);

    expect(data.state.groupBy).toBe('userId');
  });

  it('makes API key grouping explicitly current-user scoped for an administrator', async () => {
    useAuthStore.getState().primeFromLogin({ token: 'admin-session', user: { id: 1, username: 'admin', isAdmin: true, canViewUpstreams: true } });
    const performanceQueries: URL[] = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost');
      if (url.pathname === '/api/performance/overview') performanceQueries.push(url);
      return gatewayForOperator(input);
    }));

    const data = await clientLoader({ request: new Request('http://localhost/dashboard/monitor/performance?g=keyId') } as never);

    expect(data.state.groupBy).toBe('keyId');
    expect(data.state.filters.userId).toEqual(['1']);
    expect(performanceQueries[0].searchParams.getAll('filter_user_id')).toEqual(['1']);
  });

  it('re-reads a Node overview after removing stale Region URL state', async () => {
    useAuthStore.getState().primeFromLogin({ token: 'operator-session', user: { id: 2, username: 'operator', isAdmin: false, canViewUpstreams: false } });
    const fetch = vi.fn(gatewayForOperator);
    vi.stubGlobal('fetch', fetch);

    const data = await clientLoader({ request: new Request('http://localhost/dashboard/monitor/performance?g=runtimeLocation&fr=SJC') } as never);

    expect(data.regionAvailable).toBe(false);
    expect(data.state.groupBy).toBe('model');
    expect(data.state.filters.runtimeLocation).toEqual([]);
    expect(fetch.mock.calls.filter(([input]) => new URL(String(input), 'http://localhost').pathname === '/api/performance/overview')).toHaveLength(2);
  });

  it('keeps Region state on Cloudflare', async () => {
    useAuthStore.getState().primeFromLogin({ token: 'operator-session', user: { id: 2, username: 'operator', isAdmin: false, canViewUpstreams: false } });
    const fetch = vi.fn((input: RequestInfo | URL) => {
      const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost').pathname;
      return path === '/api/runtime-info'
        ? Promise.resolve(Response.json({ kind: 'cloudflare', runtimeLocation: 'SIN' }))
        : gatewayForOperator(input);
    });
    vi.stubGlobal('fetch', fetch);

    const data = await clientLoader({ request: new Request('http://localhost/dashboard/monitor/performance?g=runtimeLocation&fr=SJC') } as never);

    expect(data.regionAvailable).toBe(true);
    expect(data.state.groupBy).toBe('runtimeLocation');
    expect(data.state.filters.runtimeLocation).toEqual([]);
    expect(fetch.mock.calls.filter(([input]) => new URL(String(input), 'http://localhost').pathname === '/api/performance/overview')).toHaveLength(1);
  });

  it('preserves Region state when runtime capability cannot be determined', async () => {
    useAuthStore.getState().primeFromLogin({ token: 'operator-session', user: { id: 2, username: 'operator', isAdmin: false, canViewUpstreams: false } });
    const fetch = vi.fn((input: RequestInfo | URL) => {
      const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost').pathname;
      return path === '/api/runtime-info'
        ? Promise.resolve(Response.json({ error: 'Unavailable' }, { status: 500 }))
        : gatewayForOperator(input);
    });
    vi.stubGlobal('fetch', fetch);

    const data = await clientLoader({ request: new Request('http://localhost/dashboard/monitor/performance?g=runtimeLocation&fr=SJC') } as never);

    expect(data.regionAvailable).toBeNull();
    expect(data.state.groupBy).toBe('runtimeLocation');
    expect(data.state.filters.runtimeLocation).toEqual([]);
    expect(data.error?.message).toBe('Unavailable');
    expect(fetch.mock.calls.filter(([input]) => new URL(String(input), 'http://localhost').pathname === '/api/performance/overview')).toHaveLength(1);
  });
});
