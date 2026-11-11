import { fireEvent, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { dashboardBucketFrames } from '../../src/components/charts/dashboard-time';
import DashboardMonitorUsage, { clientLoader } from '../../src/routes/dashboard-monitor-usage';
import { useAuthStore } from '../../src/stores/auth-store';
import { resetCycles, resetLoadedAt } from '../components/telemetry/reset-fixture';
import { stubLocalStorage } from '../local-storage-stub';
import { renderInApp } from '../render';

stubLocalStorage();

afterEach(() => {
  useAuthStore.getState().clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const loadedAt = Date.UTC(2026, 7, 5, 12);
const bucket = dashboardBucketFrames('today', loadedAt).at(-2)!.key;
const usageRecord = { bucket, group: 'gpt-5', requests: 1, metrics: { input_tokens: '10' as const }, cost: null };
const loaderData = {
  range: 'today' as const,
  resetCycles: null,
  currentUserId: '1',
  error: null,
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
  upstreams: [{ id: 'up-1', name: 'Copilot seat', hue: 210 }],
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
    users: [{ id: 1, username: 'admin' }, { id: 2, username: 'Alice' }],
    auditableUserIds: [1, 2],
    upstreams: [{ id: 'up-1', name: 'Copilot seat', hue: 210 }],
    keys: [{ id: 'key-2', name: 'Alice key', createdAt: '2026-08-01T00:00:00.000Z' }],
  },
};

const renderPage = (data: Parameters<typeof DashboardMonitorUsage>[0]['loaderData']) => {
  const user = { id: 1, username: 'admin', isAdmin: true, canViewPermissions: true, canViewUpstreams: true, preferences: { quotaDisplay: 'remaining', language: null } };
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

const stubUsageGateway = () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost').pathname;
    if (path === '/api/token-usage/overview') return Response.json({
      series: [{ bucket: '2026-08-05T11', group: 'gpt-5', requests: 1, metrics: [], cost: null }],
      axes: { none: [], model: [], upstream: [], userId: [], keyId: [] },
      dimensionValues: { models: ['gpt-5'], upstreams: ['upstream:up-1'], userIds: [2], keyIds: ['key-2'] },
      users: [{ id: 1, username: 'admin' }, { id: 2, username: 'Alice' }],
      auditableUserIds: [1, 2],
      upstreams: [{ id: 'up-1', name: 'Copilot seat', hue: 210 }],
      keys: [{ id: 'key-2', name: 'Alice key', createdAt: '2026-08-01T00:00:00.000Z' }],
    });
    if (path === '/api/search-usage') return Response.json({ view: 'all-by-user', records: [], users: [] });
    throw new Error(`Unexpected request to ${path}`);
  }));
};

it('offers reset cycles only after selecting one upstream and applies the chosen metric to statistics', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(resetLoadedAt);
  const requests: URL[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname === '/api/upstream-reset-cycles') return Response.json(resetCycles);
    if (url.pathname === '/api/search-usage') return Response.json({ view: 'all-by-user', records: [], users: [] });
    if (url.pathname === '/api/token-usage/overview') {
      requests.push(url);
      return Response.json({ ...loaderData.usage, series: [], axes: { none: [], model: [], upstream: [], userId: [], keyId: [] } });
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  }));
  renderPage(loaderData);
  expect(screen.queryByRole('radio', { name: 'By cycle' })).toBeNull();
  fireEvent.click(screen.getByRole('combobox', { name: 'Upstream' }));
  fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Copilot seat' }));
  await waitFor(() => expect(screen.getByRole('radio', { name: 'By cycle' })).toBeTruthy());
  expect(screen.queryByRole('combobox', { name: 'Reset metric' })).toBeNull();
  fireEvent.click(screen.getByRole('radio', { name: 'By cycle' }));
  fireEvent.click(screen.getByRole('combobox', { name: 'Cycle' }));
  fireEvent.click(screen.getByRole('option', { name: 'Previous reset cycle' }));
  fireEvent.click(screen.getByRole('button', { name: 'View statistics' }));
  await waitFor(() => expect(requests.at(-1)?.searchParams.get('start')).toBe('2026-11-11T05'));
  expect(requests.at(-1)?.searchParams.get('end')).toBe('2026-11-11T10');
  expect(requests.at(-1)?.searchParams.getAll('filter_upstream')).toEqual(['upstream:up-1']);
  await waitFor(() => expect(screen.getByRole('radio', { name: 'By cycle' }).getAttribute('aria-checked')).toBe('true'));
  fireEvent.click(screen.getByRole('radio', { name: 'By cycle' }));
  fireEvent.click(screen.getByRole('combobox', { name: 'Reset metric' }));
  fireEvent.click(screen.getByRole('option', { name: '7-day remaining' }));
  fireEvent.click(screen.getByRole('button', { name: 'View statistics' }));
  await waitFor(() => expect(requests.at(-1)?.searchParams.get('start')).toBe('2026-11-02T09'));
  expect(requests.at(-1)?.searchParams.get('end')).toBe('2026-11-09T09');
  fireEvent.click(screen.getByRole('combobox', { name: 'Group by' }));
  fireEvent.click(screen.getByRole('option', { name: 'By Upstream' }));
  await waitFor(() => expect(screen.queryByRole('combobox', { name: 'Reset metric' })).toBeNull());
  expect(screen.queryByRole('radio', { name: 'By cycle' })).toBeNull();
  expect(screen.getByRole('radio', { name: 'Last Day' }).getAttribute('aria-checked')).toBe('true');
});

describe('usage dimension controls', () => {
  it('shows auditable users even when they have no usage in the selected window', () => {
    renderPage({
      ...loaderData,
      currentUserId: '2',
      usage: {
        ...loaderData.usage,
        dimensionValues: { ...loaderData.usage.dimensionValues, userIds: [2] },
        users: [{ id: 2, username: 'Alice' }, { id: 5, username: 'Dana' }],
      },
    });

    fireEvent.click(screen.getByRole('combobox', { name: 'Group by' }));
    expect(screen.getByRole('option', { name: 'By User' })).toBeTruthy();
    fireEvent.click(screen.getByRole('combobox', { name: 'User' }));
    expect(screen.getByRole('menuitemcheckbox', { name: 'Alice' })).toBeTruthy();
    expect(screen.getByRole('menuitemcheckbox', { name: 'Dana' })).toBeTruthy();
  });

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
    const controlsRow = screen.getByRole('group', { name: 'Group by' }).parentElement?.parentElement;
    const range = screen.getByRole('radiogroup', { name: 'Usage range' });
    expect(controlsRow?.contains(range)).toBe(true);
    expect(controlsRow?.nextElementSibling?.contains(screen.getByRole('combobox', { name: 'Upstream' }))).toBe(true);
    expect(screen.getByRole('heading', { level: 2, name: 'By Model' })).toBeTruthy();
  });

  it('hides API key filters under user grouping', () => {
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

  it('labels unknown-user usage without weakening real-user metadata checks', () => {
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

    expect(screen.getByText('Unknown user')).toBeTruthy();
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
      state: {
        ...loaderData.state,
        filters: { ...loaderData.state.filters, userId: ['1'] },
        groupBy: 'keyId',
      },
      usage: { ...loaderData.usage, series: [{ ...usageRecord, group: 'key-2' }] },
    });

    expect(screen.getByRole('button', { name: 'About API key telemetry scope' })).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'API Key' })).toBeNull();
    expect(screen.getByRole('combobox', { name: 'User' }).getAttribute('placeholder')).toBe('Only me');
  });

  it('lets an API key selection replace another user with the current-user scope', async () => {
    stubUsageGateway();
    renderPage({
      ...loaderData,
      state: {
        ...loaderData.state,
        filters: { ...loaderData.state.filters, userId: ['2'] },
      },
    });

    fireEvent.click(screen.getByRole('combobox', { name: 'API Key' }));
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Alice key' }));

    await waitFor(() => expect(screen.getByRole('combobox', { name: 'User' }).getAttribute('placeholder')).toBe('Only me'));
    expect(screen.getByRole('combobox', { name: 'API Key' }).getAttribute('placeholder')).toBe('1 selected');
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
      user: { id: 1, username: 'admin', isAdmin: true, canViewPermissions: true, canViewUpstreams: true, preferences: { quotaDisplay: 'remaining', language: null } },
    });
    stubUsageGateway();

    const data = await clientLoader({ request: new Request('http://localhost/dashboard/monitor/usage?g=userId') } as never);

    expect(data.state.groupBy).toBe('userId');
    expect(data.usage?.series[0]).toMatchObject({ group: 'gpt-5', metrics: {} });
    expect(data.upstreams).toEqual([{ id: 'up-1', name: 'Copilot seat', hue: 210 }]);
  });

  it('loads calendar statistics for a deleted upstream without reset-cycle capability', async () => {
    useAuthStore.getState().primeFromLogin({
      token: 'admin-session',
      user: { id: 1, username: 'admin', isAdmin: true, canViewPermissions: true, canViewUpstreams: true, preferences: { quotaDisplay: 'remaining', language: null } },
    });
    const requests: URL[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      requests.push(url);
      if (url.pathname === '/api/upstream-reset-cycles') return Response.json({ upstreamId: 'historical', available: false, metrics: [] });
      if (url.pathname === '/api/search-usage') return Response.json({ view: 'all-by-user', records: [], users: [] });
      if (url.pathname === '/api/token-usage/overview') return Response.json({
        ...loaderData.usage,
        upstreams: [],
        dimensionValues: { ...loaderData.usage.dimensionValues, upstreams: ['upstream:historical'] },
        series: [{ ...usageRecord, metrics: [{ metric: 'input_tokens', quantity: '10' }] }],
        axes: { none: [], model: [], upstream: [], userId: [], keyId: [] },
      });
      throw new Error(`Unexpected request: ${url.pathname}`);
    }));

    const data = await clientLoader({ request: new Request('http://localhost/dashboard/monitor/usage?r=7d&fu=upstream%3Ahistorical') } as never);

    expect(data.error).toBeNull();
    expect(data.range).toBe('7d');
    expect(data.usage?.series[0]).toMatchObject({ requests: 1, metrics: { input_tokens: '10' } });
    expect(data.resetCycles).toEqual({ upstreamId: 'historical', available: false, metrics: [] });
    expect(requests.find(url => url.pathname === '/api/token-usage/overview')?.searchParams.getAll('filter_upstream')).toEqual(['upstream:historical']);
  });

  it('reads upstream labels from the overview response', async () => {
    useAuthStore.getState().primeFromLogin({
      token: 'admin-session',
      user: { id: 1, username: 'admin', isAdmin: true, canViewPermissions: true, canViewUpstreams: true, preferences: { quotaDisplay: 'remaining', language: null } },
    });
    stubUsageGateway();

    const data = await clientLoader({ request: new Request('http://localhost/dashboard/monitor/usage') } as never);
    renderPage(data);

    expect(data.upstreams).toEqual([{ id: 'up-1', name: 'Copilot seat', hue: 210 }]);
    expect(screen.getByRole('heading', { level: 2, name: 'By Model' })).toBeTruthy();
  });

  it('keeps self-only Search usage grouped by API key', async () => {
    useAuthStore.getState().primeFromLogin({
      token: 'operator-session',
      user: { id: 2, username: 'operator', isAdmin: false, canViewPermissions: false, canViewUpstreams: false, preferences: { quotaDisplay: 'remaining', language: null } },
    });
    let requestedView: string | null = null;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost');
      if (url.pathname === '/api/token-usage/overview') return Response.json({
        series: [],
        axes: { none: [], model: [], upstream: [], userId: [], keyId: [] },
        dimensionValues: { models: [], upstreams: [], userIds: [], keyIds: [] },
        users: [{ id: 2, username: 'operator' }],
        auditableUserIds: [2],
        upstreams: [],
        keys: [],
      });
      if (url.pathname === '/api/search-usage') {
        requestedView = url.searchParams.get('view');
        return Response.json({ view: 'self-by-key', records: [], keys: [] });
      }
      throw new Error(`Unexpected request to ${url.pathname}`);
    }));

    await clientLoader({ request: new Request('http://localhost/dashboard/monitor/usage') } as never);
    expect(requestedView).toBe('self-by-key');
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
          auditableUserIds: loaderData.usage.auditableUserIds,
          upstreams: loaderData.usage.upstreams,
          keys: loaderData.usage.keys,
        });
      }
      if (url.pathname === '/api/search-usage') return Response.json({ view: 'all-by-user', records: [], users: [] });
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
