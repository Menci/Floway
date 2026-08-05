import { act } from '@testing-library/react';
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OutcomeToastProvider } from '../../src/components/ui/outcome-toast';
import DashboardServicesApiKeys, { clientLoader } from '../../src/routes/dashboard-services-api-keys';
import { flowayTokenStorageKey } from '../../src/auth/session';
import { stubLocalStorage } from '../local-storage-stub';
import { renderInApp } from '../render';

afterEach(() => vi.unstubAllGlobals());

// Which key the Agent Setup card is set up for outlives a visit, so the page
// stores the id the operator picked. What may not happen is the page throwing
// that away on its own: a visit that could not load the key list resolves no
// selection, and the stored id has to survive it for the next visit that can.
const loaderData = {
  keys: null,
  upstreams: null,
  models: null,
  error: 'Failed to fetch',
  selectedKeyId: '',
  setupError: null,
  setupLease: null,
};

const renderPage = () => {
  const router = createMemoryRouter([
    {
      path: '/',
      Component: () => <OutcomeToastProvider><Outlet context={{ user: { id: 1, username: 'admin', role: 'admin', upstreamIds: null } }} /></OutcomeToastProvider>,
      children: [{
        index: true,
        Component: () => <DashboardServicesApiKeys
          loaderData={loaderData}
          matches={[] as never}
          params={{}}
        />,
      }],
    },
  ], { initialEntries: ['/'] });
  return renderInApp(<RouterProvider router={router} />);
};

describe('API keys page', () => {
  const storage = stubLocalStorage();

  it('keeps the stored key selection through a visit that could not load the keys', async () => {
    storage.set('floway-agent-setup-selected-key', 'stored-key');
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({}, { status: 500 })));

    await act(async () => { renderPage(); });

    expect(storage.get('floway-agent-setup-selected-key')).toBe('stored-key');
  });

  it('threads navigation cancellation through page and setup requests', async () => {
    storage.set(flowayTokenStorageKey, 'session');
    storage.set('floway-agent-setup-selected-key', 'key-1');
    const controller = new AbortController();
    const request = new Request('http://localhost/dashboard/services/api-keys', { signal: controller.signal });
    const signals: AbortSignal[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal) signals.push(init.signal);
      const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost').pathname;
      if (path === '/api/keys') return Response.json([{
        id: 'key-1', name: 'Key 1', key: 'sk-key-1', upstream_ids: null,
        created_at: '2026-01-01T00:00:00.000Z', last_used_at: null,
        dump_retention_seconds: null, responses_retention_seconds: 0,
      }]);
      if (path === '/api/upstream-options') return Response.json([]);
      if (path === '/api/models') return Response.json({ data: [] });
      if (path === '/api/setup') return Response.json({});
      throw new Error(`Unexpected request to ${path}`);
    }));

    await clientLoader({ request } as never);
    controller.abort();

    expect(signals).toHaveLength(4);
    expect(signals.every(signal => signal === request.signal && signal.aborted)).toBe(true);
  });
});
