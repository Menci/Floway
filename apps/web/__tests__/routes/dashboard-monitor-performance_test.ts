import { afterEach, describe, expect, it, vi } from 'vitest';

import { clientLoader } from '../../src/routes/dashboard-monitor-performance';
import { useAuthStore } from '../../src/stores/auth-store';
import { stubLocalStorage } from '../local-storage-stub';

stubLocalStorage();

afterEach(() => {
  useAuthStore.getState().clear();
  vi.unstubAllGlobals();
});

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
    useAuthStore.getState().primeFromLogin({ token: 'operator-session', user: { id: 2, username: 'operator', isAdmin: false, upstreamIds: null } });
    vi.stubGlobal('fetch', vi.fn(gatewayForOperator));

    const data = await clientLoader({ request: new Request('http://localhost/dashboard/monitor/performance') } as never);

    expect(data.upstreamNames).toEqual([{ id: 'up-1', name: 'Copilot seat' }]);
    expect(data.error).toBeNull();
  });
});
