import { screen } from '@testing-library/react';
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import DashboardMonitorUsage, { clientLoader } from '../../src/routes/dashboard-monitor-usage';
import { useAuthStore } from '../../src/stores/auth-store';
import { stubLocalStorage } from '../local-storage-stub';
import { renderInApp } from '../render';

stubLocalStorage();

afterEach(() => {
  useAuthStore.getState().clear();
  vi.unstubAllGlobals();
});

const loadedAt = Date.UTC(2026, 7, 5, 12);
const loaderData = {
  error: null,
  filters: { identity: [], model: [], upstream: [] },
  groupBy: 'identity' as const,
  hiddenKeys: [],
  hiddenModels: [],
  hiddenUpstreams: [],
  loadedAt,
  metric: 'total' as const,
  models: [],
  range: 'today' as const,
  redactKeys: false,
  search: { records: [], keys: [] },
  upstreams: [{ id: 'up-1', name: 'Copilot seat' }],
  usage: {
    keys: [{ id: 'user-2', name: 'Alice' }],
    records: [{
      keyId: 'user-2',
      model: 'gpt-5',
      upstream: 'up-1',
      hour: '2026-08-05T11',
      requests: 1,
      metrics: { input_tokens: '10' as const },
      cost: null,
    }],
  },
  view: 'all-by-user' as const,
};

const renderPage = (data: Parameters<typeof DashboardMonitorUsage>[0]['loaderData']) => {
  const user = { id: 1, username: 'admin', isAdmin: true, upstreamIds: null };
  const router = createMemoryRouter([{
    path: '/',
    Component: () => <Outlet context={{ user }} />,
    children: [{
      index: true,
      Component: () => <DashboardMonitorUsage loaderData={data} matches={[] as never} params={{}} />,
    }],
  }], { initialEntries: ['/'] });
  return renderInApp(<RouterProvider router={router} />);
};

const stubUsageGateway = (upstreamOptions: () => Response = () => Response.json([{ id: 'up-1', name: 'Copilot seat', kind: 'copilot', enabled: true, color: null, cachedModelCount: 1 }])) => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost').pathname;
    if (path === '/api/token-usage') return Response.json({
      view: 'all-by-user',
      dimensions: ['upstream'],
      records: [{ userId: 2, model: 'gpt-5', upstream: 'up-1', hour: '2026-08-05T11', requests: 1, metrics: [], cost: null }],
      users: [{ id: 2, username: 'Alice' }],
    });
    if (path === '/api/search-usage') return Response.json({ view: 'all-by-user', records: [], users: [] });
    if (path === '/api/models') return Response.json({ data: [] });
    if (path === '/api/upstream-options') return upstreamOptions();
    throw new Error(`Unexpected request to ${path}`);
  }));
};

describe('usage dimension controls', () => {
  it('renders one token chart for the selected grouping', () => {
    renderPage(loaderData);

    expect(screen.getByRole<HTMLInputElement>('combobox', { name: 'Group by' }).value).toBe('By User');
    expect(screen.getByRole('combobox', { name: 'Model' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Upstream' })).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'User' })).toBeNull();
    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 2, name: 'By User' })).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 2, name: 'By Model' })).toBeNull();
  });

  it('retains the upstream coordinate loaded from the dashboard response', async () => {
    useAuthStore.getState().primeFromLogin({
      token: 'admin-session',
      user: { id: 1, username: 'admin', isAdmin: true, upstreamIds: null },
    });
    stubUsageGateway();

    const data = await clientLoader({ request: new Request('http://localhost/dashboard/monitor/usage') } as never);

    expect(data.usage?.records[0]).toMatchObject({ keyId: 'user-2', upstream: 'up-1' });
    expect(data.upstreams).toEqual([{ id: 'up-1', name: 'Copilot seat' }]);
  });

  it('keeps token charts available when upstream names fail to load', async () => {
    useAuthStore.getState().primeFromLogin({
      token: 'admin-session',
      user: { id: 1, username: 'admin', isAdmin: true, upstreamIds: null },
    });
    stubUsageGateway(() => Response.json({ error: 'Unavailable' }, { status: 500 }));

    const data = await clientLoader({ request: new Request('http://localhost/dashboard/monitor/usage') } as never);
    renderPage(data);

    expect(data.upstreams).toEqual([]);
    expect(screen.getByRole('heading', { level: 2, name: 'By User' })).toBeTruthy();
    expect(screen.getByText('Unavailable')).toBeTruthy();
  });
});
