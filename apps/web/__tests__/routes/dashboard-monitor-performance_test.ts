import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadPerformancePageData } from '../../src/components/performance/data';

afterEach(() => {
  vi.unstubAllGlobals();
});

const operator = { id: 2, username: 'operator', isAdmin: false, upstreamIds: null };
const admin = { id: 1, username: 'admin', isAdmin: true, upstreamIds: null };

// The gateway admin-gates every /api/upstreams route; an operator's session
// gets 403 there and 200 from the upstream picker.
const gatewayForOperator = (input: RequestInfo | URL) => {
  const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost').pathname;
  if (path === '/api/upstreams') return Promise.resolve(Response.json({ error: 'Admin privileges required' }, { status: 403 }));
  if (path === '/api/upstream-options') return Promise.resolve(Response.json([{ id: 'up-1', name: 'Copilot seat', kind: 'copilot', enabled: true, color: null, cachedModelCount: 3 }]));
  return Promise.resolve(Response.json({
    series: [], axes: { none: [], model: [], upstream: [], operation: [], runtimeLocation: [], keyId: [], userId: [] },
    dimensionValues: { models: [], upstreams: [], operations: [], runtimeLocations: [], userIds: [], keyIds: [] },
    users: [], keys: [],
  }));
};

describe('where the performance page reads upstream names from', () => {
  it('names an upstream for an operator, whose session may not read the admin upstream list', async () => {
    vi.stubGlobal('fetch', vi.fn(gatewayForOperator));

    const data = await loadPerformancePageData(new Request('http://localhost/dashboard/monitor/performance'), operator);

    expect(data.upstreamNames).toEqual([{ id: 'up-1', name: 'Copilot seat' }]);
    expect(data.error).toBeNull();
  });

  it('makes API key grouping explicitly current-user scoped for an administrator', async () => {
    const performanceQueries: URL[] = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost');
      if (url.pathname === '/api/performance/overview') performanceQueries.push(url);
      return gatewayForOperator(input);
    }));

    const data = await loadPerformancePageData(new Request('http://localhost/dashboard/monitor/performance?g=keyId'), admin);

    expect(data.state.groupBy).toBe('keyId');
    expect(data.state.filters.userId).toEqual(['1']);
    expect(performanceQueries[0].searchParams.getAll('filter_user_id')).toEqual(['1']);
  });

  it('threads navigation cancellation through every initial request', async () => {
    const controller = new AbortController();
    const request = new Request('http://localhost/dashboard/monitor/performance', { signal: controller.signal });
    const signals: AbortSignal[] = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal) signals.push(init.signal);
      return gatewayForOperator(input);
    }));

    await loadPerformancePageData(request, operator);
    controller.abort();

    expect(signals).toHaveLength(2);
    expect(signals.every(signal => signal === request.signal && signal.aborted)).toBe(true);
  });
});
