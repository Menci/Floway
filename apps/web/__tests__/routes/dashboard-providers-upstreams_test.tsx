import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, Outlet, RouterProvider, useLoaderData } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { ListedUpstreamRecord, UpstreamRecord } from '../../src/api/types';
import { OutcomeToastProvider } from '../../src/components/ui/outcome-toast';
import DashboardProvidersUpstreams from '../../src/routes/dashboard-providers-upstreams';
import { upstreamRecord } from '../api/upstream-fixture';
import { stubLocalStorage } from '../local-storage-stub';
import { renderInApp } from '../render';
import { primeDefaultSession } from '../test-session';

stubLocalStorage();
beforeEach(() => { primeDefaultSession(); vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1100, 320)); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

const user = { id: 1, username: 'admin', isAdmin: true, canViewPermissions: true, canViewUpstreams: true };
const records: UpstreamRecord[] = ['First', 'Second'].map((name, index) => upstreamRecord(name.toLowerCase(), {
  name, kind: 'copilot', enabled: false, sort_order: index, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z',
  config: { githubHost: 'github.com', githubTokenSet: true, user: { id: index + 1, login: name.toLowerCase(), name, avatar_url: '' } },
  state: null, flag_overrides: {}, disabled_public_model_ids: [], proxy_fallback_list: [], model_prefix: null, hue: 210,
  usage_refresh_interval_minutes: 0, modelsCache: { fetchedAt: null, lastError: null, modelCount: null },
}));
const toListed = (
  record: UpstreamRecord,
  access: { audit: boolean; edit: ListedUpstreamRecord['editLevel'] } = { audit: true, edit: 'full' },
  overrides: Partial<ListedUpstreamRecord> = {},
): ListedUpstreamRecord => ({
  ...record,
  audit: access.audit,
  editLevel: access.edit,
  modelUse: true,
  reorderGroup: access.edit === 'full' ? 'default-full-segment' : null,
  ...overrides,
} as ListedUpstreamRecord);
const listedRecords = (source: readonly UpstreamRecord[]): ListedUpstreamRecord[] => source.map(record => toListed(record));
const loaderData = {
  upstreams: listedRecords(records),
  models: [], loadError: null, modelsError: null,
};
const withAccess = (audit: boolean, edit: 'off' | 'models' | 'full'): typeof loaderData => ({
  ...loaderData,
  upstreams: loaderData.upstreams.map((record, index) => index === 0 ? toListed(record, { audit, edit }) : record),
});
const renderPage = (displayUser = user, pageData: typeof loaderData = loaderData) => renderInApp(<RouterProvider router={createMemoryRouter([
  {
    path: '/dashboard', element: <OutcomeToastProvider><Outlet context={{ user: displayUser }} /></OutcomeToastProvider>, children: [
      { path: 'providers/upstreams', loader: () => pageData, Component: () => <DashboardProvidersUpstreams loaderData={useLoaderData() as never} params={{}} matches={[] as never} /> },
      { path: 'providers/upstreams/:id', element: <div>Editor</div> },
    ],
  },
], { initialEntries: ['/dashboard/providers/upstreams'] })} />);
const metricsButton = (name: string) => screen.getAllByRole('button', { name: `Usage and metrics for ${name}` }).find(node => node.tagName === 'BUTTON')!;
const overview = (groupBy = 'model') => ({
  series: [{ bucket: new Date(Date.now() - 3_600_000).toISOString().slice(0, 13), group: groupBy === 'model' ? 'gpt-5' : '1', requests: 1, metrics: [{ metric: 'input_tokens', quantity: '10' }], cost: null }],
  axes: { none: [], model: [], upstream: [], userId: [], keyId: [] },
  dimensionValues: { models: ['gpt-5'], upstreams: ['upstream:first'], userIds: [1], keyIds: [] }, users: [{ id: 1, username: 'admin' }], auditableUserIds: [1], upstreams: [{ id: 'first', name: 'First', hue: 210 }], keys: [],
});
const metrics = (url: URL) => ({
  start: Number(url.searchParams.get('start')), end: Number(url.searchParams.get('end')), step: Number(url.searchParams.get('step')),
  records: [
    { upstreamId: url.searchParams.get('upstream_id'), name: 'quota.remaining', labels: { quota: 'premium_interactions' }, timestamp: Date.now() - 1_000, value: 25 },
    { upstreamId: url.searchParams.get('upstream_id'), name: 'quota.entitlement', labels: { quota: 'premium_interactions' }, timestamp: Date.now() - 1_000, value: 100 },
  ],
});
const stubGateway = (
  handler: (url: URL, signal: AbortSignal | undefined) => Promise<Response>,
  pageData: typeof loaderData = loaderData,
) => vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
  if (url.pathname === '/api/upstreams') return Response.json(pageData.upstreams);
  if (url.pathname === '/api/models') return Response.json({ data: [] });
  return await handler(url, init?.signal as AbortSignal | undefined);
}));

it('blocks the surface until both readings load, then opens a single row with Usage above Metrics', async () => {
  let finishUsage!: () => void;
  let finishMetrics!: () => void;
  const requests: URL[] = [];
  stubGateway(async url => {
    requests.push(url);
    if (url.pathname === '/api/token-usage/overview') { await new Promise<void>(resolve => { finishUsage = resolve; }); return Response.json(overview()); }
    if (url.pathname === '/api/upstream-metrics') { await new Promise<void>(resolve => { finishMetrics = resolve; }); return Response.json(metrics(url)); }
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  const view = renderPage();
  fireEvent.click(await waitFor(() => metricsButton('First')));
  await waitFor(() => expect(requests).toHaveLength(2));
  expect(view.container.querySelector('section.dashboard-page')!.getAttribute('aria-busy')).toBe('true');
  expect(view.container.querySelector('[inert]')).not.toBeNull();
  expect(metricsButton('First').getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByRole('heading', { name: 'Usage' })).toBeNull();
  expect(requests.find(url => url.pathname === '/api/token-usage/overview')!.searchParams.get('filter_upstream')).toBe('upstream:first');
  expect(requests.find(url => url.pathname === '/api/upstream-metrics')!.searchParams.get('upstream_id')).toBe('first');
  await act(async () => finishUsage());
  expect(metricsButton('First').getAttribute('aria-expanded')).toBe('false');
  await act(async () => finishMetrics());
  await waitFor(() => expect(metricsButton('First').getAttribute('aria-expanded')).toBe('true'));
  const usage = screen.getByRole('heading', { name: 'Usage' });
  const metric = screen.getByRole('heading', { name: 'Metrics' });
  expect(usage.compareDocumentPosition(metric) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  expect(screen.getAllByRole('combobox')).toHaveLength(3);
  expect(screen.queryByRole('combobox', { name: 'Upstream' })).toBeNull();
  fireEvent.click(screen.getByRole('combobox', { name: 'Group by' }));
  expect(screen.queryByRole('option', { name: 'By Upstream' })).toBeNull();
});

it('shows Usage without an empty Metrics section when the upstream has no observations', async () => {
  stubGateway(async url => {
    if (url.pathname === '/api/token-usage/overview') return Response.json(overview());
    if (url.pathname === '/api/upstream-metrics') return Response.json({ start: Number(url.searchParams.get('start')), end: Number(url.searchParams.get('end')), step: Number(url.searchParams.get('step')), records: [] });
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  renderPage();
  fireEvent.click(await waitFor(() => metricsButton('First')));

  await waitFor(() => expect(metricsButton('First').getAttribute('aria-expanded')).toBe('true'));
  expect(screen.getByRole('heading', { name: 'Usage' })).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'Metrics' })).toBeNull();
});

it('keeps the current row on failed loading and allows another attempt', async () => {
  let fail = true;
  stubGateway(async url => url.pathname === '/api/token-usage/overview' ? Response.json(overview())
    : fail ? Response.json({ error: 'Metrics unavailable' }, { status: 500 }) : Response.json(metrics(url)));
  renderPage();
  fireEvent.click(await waitFor(() => metricsButton('First')));
  await screen.findByText('Metrics unavailable');
  await waitFor(() => expect(metricsButton('First').getAttribute('aria-expanded')).toBe('false'));
  fail = false;
  fireEvent.click(metricsButton('First'));
  await waitFor(() => expect(metricsButton('First').getAttribute('aria-expanded')).toBe('true'));
  fireEvent.click(metricsButton('Second'));
  await waitFor(() => expect(metricsButton('Second').getAttribute('aria-expanded')).toBe('true'));
  expect(metricsButton('First').getAttribute('aria-expanded')).toBe('false');
}, 15_000);

it('cancels both telemetry requests when navigating away during an expansion', async () => {
  const signals: AbortSignal[] = [];
  stubGateway(async (_url, signal) => { signals.push(signal!); return await new Promise<Response>(() => {}); });
  const view = renderPage();
  fireEvent.click(await waitFor(() => metricsButton('First')));
  await waitFor(() => expect(signals).toHaveLength(2));
  view.unmount();
  expect(signals.every(signal => signal.aborted)).toBe(true);
});

it('expands the whole row while preserving switch, icon and navigation actions', async () => {
  const readings: URL[] = [];
  stubGateway(async url => {
    if (url.pathname.startsWith('/api/upstreams/')) return Response.json({ error: 'Toggle rejected' }, { status: 500 });
    readings.push(url);
    if (url.pathname === '/api/token-usage/overview') return Response.json(overview());
    if (url.pathname === '/api/upstream-metrics') return Response.json(metrics(url));
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  renderPage();
  const row = await screen.findByRole('row', { name: 'Usage and metrics for First' });
  fireEvent.click(screen.getAllByRole('switch')[0]);
  await screen.findByText(/Toggle rejected/);
  expect(readings).toHaveLength(0);
  fireEvent.click(row);
  await waitFor(() => expect(row.getAttribute('aria-expanded')).toBe('true'));
  expect(readings).toHaveLength(2);
  fireEvent.click(metricsButton('First'));
  await waitFor(() => expect(row.getAttribute('aria-expanded')).toBe('false'));
  expect(readings).toHaveLength(2);
  fireEvent.click(screen.getByRole('link', { name: 'First' }));
  await screen.findByText('Editor');
  expect(readings).toHaveLength(2);
}, 15_000);

it('handles a reorder shortcut once at the item container', async () => {
  const reorders: Array<{ expectedIds: string[]; ids: string[] }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
    if (url.pathname === '/api/upstreams/reorder' && init?.method === 'POST') {
      reorders.push(JSON.parse(init.body as string));
      return Response.json({ ok: true });
    }
    if (url.pathname === '/api/upstreams') return Response.json(loaderData.upstreams);
    if (url.pathname === '/api/models') return Response.json({ data: [] });
    throw new Error(`Unexpected request: ${url.pathname}`);
  }));
  renderPage();
  const handle = await screen.findByRole('button', { name: 'Reorder upstream First' });
  handle.focus();
  fireEvent.keyDown(handle, { key: 'ArrowDown' });
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Reorder upstream Second' }));
  fireEvent.keyDown(handle, { key: 'ArrowDown', altKey: true, shiftKey: true });
  await waitFor(() => expect(reorders).toEqual([{ expectedIds: ['first', 'second'], ids: ['second', 'first'] }]));
});

it('opens telemetry and the read-only editor for an audit-only row while keeping mutations unavailable', async () => {
  const pageData = {
    ...withAccess(true, 'off'),
    upstreams: withAccess(true, 'off').upstreams.map((record, index) => index === 0 ? { ...record, modelUse: false, modelsCache: { ...record.modelsCache, modelCount: 7 } } : record),
  };
  stubGateway(async url => {
    if (url.pathname === '/api/token-usage/overview') return Response.json(overview());
    if (url.pathname === '/api/upstream-metrics') return Response.json(metrics(url));
    throw new Error(`Unexpected request: ${url.pathname}`);
  }, pageData);
  renderPage({ id: 2, username: 'auditor', isAdmin: false, canViewPermissions: false, canViewUpstreams: true }, pageData);

  const row = await screen.findByRole('row', { name: 'Usage and metrics for First' });
  expect(screen.getByRole('link', { name: 'First' })).toBeTruthy();
  expect(within(row).getByText('7 models')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Edit upstream First' }).getAttribute('aria-disabled')).toBeNull();
  expect(screen.getByRole('switch', { name: 'Toggle upstream First' }).hasAttribute('disabled')).toBe(true);
  expect(screen.queryByRole('button', { name: 'Copy upstream First' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Delete upstream First' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Reorder upstream First' }).hasAttribute('disabled')).toBe(true);

  fireEvent.click(metricsButton('First'));
  await waitFor(() => expect(row.getAttribute('aria-expanded')).toBe('true'));
});

it('shows a models row with models editing but a disabled switch and drag handle', async () => {
  stubGateway(async url => {
    if (url.pathname === '/api/token-usage/overview') return Response.json(overview());
    if (url.pathname === '/api/upstream-metrics') return Response.json(metrics(url));
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  renderPage({ id: 2, username: 'model-editor', isAdmin: false, canViewPermissions: false, canViewUpstreams: true }, withAccess(false, 'models'));
  expect(await screen.findByRole('link', { name: 'First' })).toBeTruthy();
  expect(screen.getByRole('switch', { name: 'Toggle upstream First' }).hasAttribute('disabled')).toBe(true);
  expect(screen.getByRole('button', { name: 'Reorder upstream First' }).hasAttribute('disabled')).toBe(true);
  expect(metricsButton('First').hasAttribute('disabled')).toBe(true);
});

it('lets only a contiguous full segment move and leaves its locked neighbours in place', async () => {
  const segmented = ['Locked', 'Full A', 'Full B', 'Tail'].map((name, index) => toListed(records[index % 2]!, {
    audit: true,
    edit: index === 1 || index === 2 ? 'full' : 'off',
  }, { id: name.toLowerCase().replaceAll(' ', '-'), name, sort_order: index }));
  const reorders: Array<{ expectedIds: string[]; ids: string[] }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
    if (url.pathname === '/api/upstreams/reorder' && init?.method === 'POST') {
      reorders.push(JSON.parse(init.body as string));
      return Response.json({ ok: true });
    }
    if (url.pathname === '/api/upstreams') return Response.json(segmented);
    if (url.pathname === '/api/models') return Response.json({ data: [] });
    throw new Error(`Unexpected request: ${url.pathname}`);
  }));
  renderPage(user, { ...loaderData, upstreams: segmented });

  const handle = await screen.findByRole('button', { name: 'Reorder upstream Full A' });
  handle.focus();
  fireEvent.keyDown(handle, { key: 'ArrowDown', altKey: true, shiftKey: true });
  await waitFor(() => expect(reorders).toEqual([{ expectedIds: ['full-a', 'full-b'], ids: ['full-b', 'full-a'] }]));
  const ranks = [...document.querySelectorAll('[data-reorder-item]')].map(row => row.textContent);
  expect(ranks[0]).toContain('1');
  expect(ranks[3]).toContain('4');
});

it('does not move visible Full rows separated by a hidden server-side boundary', async () => {
  const separated = ['Full A', 'Full B'].map((name, index) => toListed(records[index]!, {
    audit: true,
    edit: 'full',
  }, { id: name.toLowerCase().replaceAll(' ', '-'), name, reorderGroup: `segment-${index}` }));
  const reorders: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
    if (url.pathname === '/api/upstreams/reorder' && init?.method === 'POST') { reorders.push(init.body); return Response.json({ ok: true }); }
    if (url.pathname === '/api/upstreams') return Response.json(separated);
    if (url.pathname === '/api/models') return Response.json({ data: [] });
    throw new Error(`Unexpected request: ${url.pathname}`);
  }));
  renderPage(user, { ...loaderData, upstreams: separated });

  const handle = await screen.findByRole('button', { name: 'Reorder upstream Full A' });
  handle.focus();
  expect(handle.hasAttribute('disabled')).toBe(false);
  fireEvent.keyDown(handle, { key: 'ArrowDown', altKey: true, shiftKey: true });
  expect(reorders).toEqual([]);
});

it('renders a lone full row as a pressable but immovable handle', async () => {
  const segmented = ['Locked A', 'Only Full', 'Locked B'].map((name, index) => toListed(records[index % 2]!, {
    audit: true,
    edit: index === 1 ? 'full' : 'off',
  }, { id: name.toLowerCase().replaceAll(' ', '-'), name, sort_order: index }));
  const reorders: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
    if (url.pathname === '/api/upstreams/reorder' && init?.method === 'POST') { reorders.push(init.body); return Response.json({ ok: true }); }
    if (url.pathname === '/api/upstreams') return Response.json(segmented);
    if (url.pathname === '/api/models') return Response.json({ data: [] });
    throw new Error(`Unexpected request: ${url.pathname}`);
  }));
  renderPage(user, { ...loaderData, upstreams: segmented });
  const handle = await screen.findByRole('button', { name: 'Reorder upstream Only Full' });
  handle.focus();
  expect(handle.hasAttribute('disabled')).toBe(false);
  fireEvent.pointerDown(handle, { button: 0, clientY: 10, isPrimary: true, pointerId: 1 });
  expect(handle.closest('[data-reorder-item]')?.getAttribute('data-reorder-edge')).toBe('first');
  fireEvent.pointerUp(window, { clientY: 10, pointerId: 1 });
  fireEvent.keyDown(handle, { key: 'ArrowDown', altKey: true, shiftKey: true });
  expect(reorders).toEqual([]);
});
