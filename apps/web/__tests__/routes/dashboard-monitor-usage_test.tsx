import { fireEvent, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { dashboardBucketFrames } from '../../src/components/charts/dashboard-time';
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
const bucket = dashboardBucketFrames('today', loadedAt).at(-2)!.key;
const usageRecord = { bucket, group: 'gpt-5', requests: 1, metrics: { input_tokens: '10' as const }, cost: null };
const loaderData = {
  error: null,
  isAdmin: true,
  loadedAt,
  search: { records: [], keys: [] },
  state: {
    filters: { model: [], upstream: [], userId: [], keyId: [] },
    groupBy: 'model' as const,
    hidden: [],
    hiddenSearch: [],
    metric: 'total' as const,
    range: 'today' as const,
  },
  upstreams: [{ id: 'up-1', name: 'Copilot seat' }],
  usage: {
    series: [usageRecord],
    axes: {
      none: [{ ...usageRecord, group: 'all' }],
      model: [{ ...usageRecord, bucket: 'all' }],
      upstream: [{ ...usageRecord, bucket: 'all', group: 'upstream:up-1' }],
      userId: [{ ...usageRecord, bucket: 'all', group: '2' }],
      keyId: [{ ...usageRecord, bucket: 'all', group: 'key-2' }],
    },
    dimensionValues: { models: ['gpt-5'], upstreams: ['upstream:up-1'], userIds: [2], keyIds: ['key-2'] },
    users: [{ id: 2, username: 'Alice' }],
    keys: [{ id: 'key-2', name: 'Alice key', createdAt: '2026-08-01T00:00:00.000Z' }],
  },
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

const stubUsageGateway = (upstreamOptions: () => Response = () => Response.json([{ id: 'up-1', name: 'Copilot seat', kind: 'copilot', enabled: true, hue: 210, cachedModelCount: 1 }])) => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost').pathname;
    if (path === '/api/token-usage/overview') return Response.json({
      series: [{ bucket: '2026-08-05T11', group: 'gpt-5', requests: 1, metrics: [], cost: null }],
      axes: { none: [], model: [], upstream: [], userId: [], keyId: [] },
      dimensionValues: { models: ['gpt-5'], upstreams: ['upstream:up-1'], userIds: [2], keyIds: [] },
      users: [{ id: 2, username: 'Alice' }],
      keys: [],
    });
    if (path === '/api/search-usage') return Response.json({ view: 'all-by-user', records: [], users: [] });
    if (path === '/api/upstream-options') return upstreamOptions();
    throw new Error(`Unexpected request to ${path}`);
  }));
};

describe('usage dimension controls', () => {
  it('matches the Performance dimension and range controls', () => {
    renderPage(loaderData);

    expect(screen.getByRole<HTMLInputElement>('combobox', { name: 'Group by' }).value).toBe('By Model');
    expect(screen.queryByRole('combobox', { name: 'Model' })).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Upstream' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'User' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'API Key' })).toBeTruthy();
    expect(screen.getByText('Last Day')).toBeTruthy();
    expect(screen.getByText('7 Days')).toBeTruthy();
    expect(screen.getByText('30 Days')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'By Model' })).toBeTruthy();
  });

  it('hides both identity filters while grouping by either identity dimension', () => {
    renderPage({
      ...loaderData,
      state: { ...loaderData.state, groupBy: 'userId' },
      usage: { ...loaderData.usage, series: [{ ...usageRecord, group: '2' }] },
    });

    expect(screen.getByRole<HTMLInputElement>('combobox', { name: 'Group by' }).value).toBe('By User');
    expect(screen.queryByRole('combobox', { name: 'User' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'API Key' })).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Model' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Upstream' })).toBeTruthy();
  });

  it('labels unattributed user usage without weakening real-user metadata checks', () => {
    const { unmount } = renderPage({
      ...loaderData,
      state: { ...loaderData.state, groupBy: 'userId' },
      usage: {
        ...loaderData.usage,
        series: [{ ...usageRecord, group: '0' }],
        axes: { ...loaderData.usage.axes, userId: [{ ...usageRecord, bucket: 'all', group: '0' }] },
        dimensionValues: { ...loaderData.usage.dimensionValues, userIds: [0] },
        users: [],
      },
    });

    expect(screen.getByText('Unattributed user')).toBeTruthy();
    unmount();

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderPage({
      ...loaderData,
      usage: { ...loaderData.usage, users: [] },
    });
    expect(screen.getByText('Usage user dimension is missing metadata for 2')).toBeTruthy();
    consoleError.mockRestore();
  });

  it('discloses that API key grouping is account-scoped', () => {
    renderPage({
      ...loaderData,
      state: { ...loaderData.state, groupBy: 'keyId' },
      usage: { ...loaderData.usage, series: [{ ...usageRecord, group: 'key-2' }] },
    });

    expect(screen.getByRole('button', { name: 'About API key telemetry scope' })).toBeTruthy();
  });

  it('uses the ungrouped axis for stable summary totals', () => {
    renderPage({
      ...loaderData,
      usage: {
        ...loaderData.usage,
        axes: {
          ...loaderData.usage.axes,
          none: [{ ...loaderData.usage.axes.none[0], metrics: { input_tokens: '99' } }],
        },
      },
    });

    expect(screen.getAllByText('99').length).toBeGreaterThan(0);
  });

  it('loads the overview contract and derives Search scope from the actor', async () => {
    useAuthStore.getState().primeFromLogin({
      token: 'admin-session',
      user: { id: 1, username: 'admin', isAdmin: true, upstreamIds: null },
    });
    stubUsageGateway();

    const data = await clientLoader({ request: new Request('http://localhost/dashboard/monitor/usage?g=userId') } as never);

    expect(data.state.groupBy).toBe('userId');
    expect(data.usage?.series[0]).toMatchObject({ group: 'gpt-5', metrics: {} });
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
    expect(screen.getByRole('heading', { level: 2, name: 'By Model' })).toBeTruthy();
    expect(screen.getByText('Unavailable')).toBeTruthy();
  });

  it('retries a failed grouping when the operator selects it again', async () => {
    let overviewRequests = 0;
    const requestedGroups: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost');
      if (url.pathname === '/api/token-usage/overview') {
        overviewRequests += 1;
        const groupBy = url.searchParams.get('group_by') ?? 'model';
        requestedGroups.push(groupBy);
        if (overviewRequests === 1) return Response.json({ error: 'Unavailable' }, { status: 500 });
        return Response.json({
          series: [{
            ...usageRecord,
            group: groupBy === 'upstream' ? 'upstream:up-1' : 'gpt-5',
            metrics: [{ metric: 'input_tokens', quantity: '10' }],
          }],
          axes: { none: [], model: [], upstream: [], userId: [], keyId: [] },
          dimensionValues: loaderData.usage.dimensionValues,
          users: loaderData.usage.users,
          keys: loaderData.usage.keys,
        });
      }
      if (url.pathname === '/api/search-usage') return Response.json({ view: 'all-by-user', records: [], users: [] });
      if (url.pathname === '/api/upstream-options') return Response.json([{ id: 'up-1', name: 'Copilot seat' }]);
      throw new Error(`Unexpected request to ${url.pathname}`);
    }));
    renderPage(loaderData);

    const chooseUpstream = () => {
      fireEvent.click(screen.getByRole('combobox', { name: 'Group by' }));
      fireEvent.click(screen.getByRole('option', { name: 'By Upstream' }));
    };
    chooseUpstream();
    await waitFor(() => expect(overviewRequests).toBe(1));
    expect(screen.getByRole<HTMLInputElement>('combobox', { name: 'Group by' }).value).toBe('By Model');

    fireEvent.click(screen.getByText('7 Days'));
    await waitFor(() => expect(overviewRequests).toBe(2));
    expect(requestedGroups).toEqual(['upstream', 'model']);

    chooseUpstream();
    await waitFor(() => expect(overviewRequests).toBe(3));
    expect(requestedGroups).toEqual(['upstream', 'model', 'upstream']);
    await waitFor(() => expect(screen.getByRole<HTMLInputElement>('combobox', { name: 'Group by' }).value).toBe('By Upstream'));
  });
});
