import { act } from '@testing-library/react';
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import DashboardMonitorRequests, { clientLoader } from '../../src/routes/dashboard-monitor-requests';
import { flowayTokenStorageKey } from '../../src/auth/session';
import { stubLocalStorage } from '../local-storage-stub';
import { renderInApp } from '../render';

const storage = stubLocalStorage();

afterEach(() => vi.unstubAllGlobals());

// The shape a background refresh leaves behind when the account genuinely holds
// no key with dump retention and the poll that re-read them failed: an empty
// list carrying an error. Null would be a fetch that never landed a list at
// all, which the page reports differently.
const loaderData = {
  collected: null,
  error: 'HTTP 500',
  keys: [],
  record: null,
  recordError: null,
  records: [],
  recordsError: null,
  selectedKeyId: null,
};

const renderPage = () => {
  const router = createMemoryRouter([
    {
      path: '/',
      Component: () => <Outlet />,
      children: [{
        index: true,
        Component: () => <DashboardMonitorRequests
          loaderData={loaderData}
          matches={[] as never}
          params={{}}
        />,
      }],
    },
  ], { initialEntries: ['/'] });
  return renderInApp(<RouterProvider router={router} />);
};

describe('requests page', () => {
  it('reports a refresh failure that arrived over an empty key list', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({}, { status: 500 })));

    let view!: ReturnType<typeof renderPage>;
    await act(async () => { view = renderPage(); });

    expect(view.queryByText('HTTP 500')).not.toBeNull();
  });

  it('threads navigation cancellation through its initial requests', async () => {
    storage.set(flowayTokenStorageKey, 'session');
    const controller = new AbortController();
    const request = new Request('http://localhost/dashboard/monitor/requests?key=key-1', { signal: controller.signal });
    const signals: AbortSignal[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal) signals.push(init.signal);
      const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost').pathname;
      if (path === '/api/keys') return Response.json([{
        id: 'key-1', name: 'Key 1', key: 'sk-key-1', upstream_ids: null,
        created_at: '2026-01-01T00:00:00.000Z', last_used_at: null,
        dump_retention_seconds: 3600, responses_retention_seconds: 0,
      }]);
      if (path === '/api/dump/keys/key-1/records') return Response.json({ records: [] });
      throw new Error(`Unexpected request to ${path}`);
    }));

    await clientLoader({ request } as never);
    controller.abort();

    expect(signals).toHaveLength(2);
    expect(signals.every(signal => signal === request.signal && signal.aborted)).toBe(true);
  });
});
