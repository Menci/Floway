import { fireEvent, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { dashboardBucketFrames } from '../../src/components/charts/dashboard-time';
import { resetRangeAt } from '../../src/components/telemetry/reset-cycles';
import { createUsageOverviewLoader } from '../../src/components/usage/data';
import { serializeUsageUrlState } from '../../src/components/usage/url-state';
import { i18n } from '../../src/i18n';
import DashboardMonitorUsage, { clientLoader } from '../../src/routes/dashboard-monitor-usage';
import { useAuthStore } from '../../src/stores/auth-store';
import { resetHistory } from '../components/telemetry/reset-fixture';
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
  loadOverview: createUsageOverviewLoader(),
  currentUserId: '1',
  error: null,
  loadedAt,
  range: 'today' as const,
  resetCycles: null,
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
  const user = { id: 1, username: 'admin', isAdmin: true, canViewPermissions: true, canViewUpstreams: true, preferences: { quotaDisplay: 'remaining', language: null, uiTextEditor: false } };
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

describe('usage dimension controls', () => {
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

    expect(screen.getByText(i18n.t('monitoring.usage.filters.unknownUser'))).toBeTruthy();
    unmount();

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderPage({
      ...loaderData,
      usage: { ...loaderData.usage, users: [] },
    });
    expect(consoleError.mock.calls.flat().some(argument => argument instanceof TypeError)).toBe(true);
    consoleError.mockRestore();
  });

  it('keeps self-only Search usage grouped by API key', async () => {
    useAuthStore.getState().primeFromLogin({
      token: 'operator-session',
      user: { id: 2, username: 'operator', isAdmin: false, canViewPermissions: false, canViewUpstreams: false, preferences: { quotaDisplay: 'remaining', language: null, uiTextEditor: false } },
    });
    let requestedView: string | null = null;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost');
      if (url.pathname === '/api/token-usage/overview') return Response.json({
        cursor: 'first', reset: true, start: url.searchParams.get('start'), end: url.searchParams.get('end'),
        buckets: [],
        scope: { actorId: 2, ownedKeyIds: [], visibility: { userIds: [2], upstreamIds: [] } },
        metadataVisibility: { complete: false, userIds: [2], upstreamIds: [] },
        users: [{ id: 2, username: 'operator' }],
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

  it('restores a historical cycle only for the single upstream named by the usage filter', async () => {
    useAuthStore.getState().primeFromLogin({
      token: 'operator-session',
      user: { id: 1, username: 'admin', isAdmin: true, canViewPermissions: true, canViewUpstreams: true, preferences: { quotaDisplay: 'remaining', language: null, uiTextEditor: false } },
    });
    const history = resetHistory(loadedAt);
    const range = resetRangeAt(history.upstreamId, history.metrics[0]!, 2)!;
    const requests: URL[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
      requests.push(url);
      if (url.pathname === '/api/upstream-reset-cycles') return Response.json({ ...history, quota: { kind: 'estimated', usd: '123.5' } });
      if (url.pathname === '/api/token-usage/overview') return Response.json({
        cursor: 'first', reset: true, start: url.searchParams.get('start'), end: url.searchParams.get('end'),
        buckets: [], scope: { actorId: 1, ownedKeyIds: [], visibility: 'all' },
        metadataVisibility: { complete: true, userIds: [1], upstreamIds: ['up-1'] },
        users: [{ id: 1, username: 'admin' }], upstreams: loaderData.upstreams, keys: [],
      });
      if (url.pathname === '/api/search-usage') return Response.json({ view: 'self-by-key', records: [], keys: [] });
      throw new Error(`Unexpected request to ${url.pathname}`);
    }));
    const load = (upstream: string[]) => {
      const search = serializeUsageUrlState({ ...loaderData.state, range, filters: { ...loaderData.state.filters, upstream } });
      return clientLoader({ request: new Request(`http://localhost/dashboard/monitor/usage?${search}`) } as never);
    };
    const selected = await load(['upstream:up-1']);
    expect(selected.state.range).toEqual(range);
    expect(requests.find(url => url.pathname === '/api/upstream-reset-cycles')?.searchParams.get('upstream_id')).toBe('up-1');
    const overview = requests.find(url => url.pathname === '/api/token-usage/overview');
    expect(overview?.searchParams.get('start')).toBe('2026-08-04T23');
    expect(overview?.searchParams.get('end')).toBe('2026-08-05T04');
    const { unmount } = renderPage(selected);
    expect(screen.getByRole('radio', { name: 'By Reset Cycle' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('Estimated cycle quota: $123.50')).toBeTruthy();
    unmount();

    for (const upstream of [[], ['upstream:up-1', 'upstream:up-2']]) {
      requests.length = 0;
      const result = await load(upstream);
      expect(result.state.range).toBe('today');
      expect(result.resetCycles).toBeNull();
      expect(requests.some(url => url.pathname === '/api/upstream-reset-cycles')).toBe(false);
    }
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
          cursor: 'new', reset: true, start: url.searchParams.get('start'), end: url.searchParams.get('end'),
          buckets: [],
          scope: { actorId: 1, ownedKeyIds: ['key-2'], visibility: 'all' },
          users: loaderData.usage.users,
          metadataVisibility: { complete: true, userIds: loaderData.usage.auditableUserIds, upstreamIds: ['up-1'] },
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
