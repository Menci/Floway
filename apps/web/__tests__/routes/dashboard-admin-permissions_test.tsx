import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider as MemoryRouterProvider, useLoaderData } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { PermissionsData } from '../../src/components/access-control/data';
import { PermissionsWorkspace } from '../../src/components/access-control/workspace';
import { OutcomeToastProvider } from '../../src/components/ui/outcome-toast';
import DashboardAdminPermissions, { clientLoader, shouldRevalidate } from '../../src/routes/dashboard-admin-permissions';
import { useAuthStore } from '../../src/stores/auth-store';
import { renderInApp } from '../render';

vi.mock('../../src/components/ui/json-editor', () => ({ JsonEditor: () => null }));

const scope = { kind: 'upstream', upstreamId: 'a' } as const;
const initial: PermissionsData = {
  directory: {
    users: [{ id: 2, username: 'alice', isAdmin: false, createdAt: '', preferences: { quotaDisplay: 'remaining' as const, language: null }, groupIds: [1] }],
    groups: [{ id: 1, name: 'Platform', hue: 210, memberIds: [2], createdAt: '', deletedAt: null }],
    principalUserIds: [2],
    principalGroupIds: [1],
  },
  records: [
    { id: 1, principal: { kind: 'group', id: 1 }, scope: { kind: 'upstreams' }, sortOrder: 0, values: { 'Model.Use': true }, createdAt: '', updatedAt: '' },
    { id: 2, principal: { kind: 'group', id: 1 }, scope, sortOrder: 0, values: { 'Model.Use': false, 'Upstream.Audit': true }, createdAt: '', updatedAt: '' },
    { id: 3, principal: { kind: 'user', id: 2 }, scope, sortOrder: 0, values: { 'Model.Use': true }, createdAt: '', updatedAt: '' },
  ],
  models: [], upstreams: [{ id: 'a', name: 'Copilot', kind: 'copilot', hue: 210, enabled: true, cachedModelCount: 0 }], error: null,
};

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    if (path === '/api/access-resolve') {
      const body = JSON.parse(init!.body as string);
      const records = body.scope.kind === 'upstreams' ? [initial.records![0]] : body.principal.kind === 'group' ? initial.records!.slice(0, 2) : initial.records!;
      return Response.json({
        records,
        values: { 'Model.Use': true, 'Upstream.Audit': true, 'Upstream.Edit': 'off' },
        decisions: records.map(record => ({
          recordId: record!.id,
          permissions: {
            'Model.Use': record!.id === 3 || body.scope.kind === 'upstreams' ? { kind: 'effective' } : { kind: 'overridden', by: initial.records![2] },
            ...(record!.id === 2 ? { 'Upstream.Audit': { kind: 'effective' } } : {}),
          },
        })),
      });
    }
    if (path === '/api/permissions') return Response.json({ records: initial.records, directory: initial.directory, upstreams: initial.upstreams });
    if (path === '/api/models') return Response.json({ data: initial.models });
    throw new Error(`Unexpected request: ${path}`);
  }));
});
afterEach(() => {
  useAuthStore.getState().clear();
  vi.unstubAllGlobals();
});
const renderPage = (search = '', data = initial) => {
  const router = createMemoryRouter([{
    path: '/permissions', loader: () => ({ ...data, admin: true }), shouldRevalidate,
    Component: () => <OutcomeToastProvider><DashboardAdminPermissions loaderData={useLoaderData() as never} params={{}} matches={[] as never} /></OutcomeToastProvider>,
  }], { initialEntries: [`/permissions${search}`] });
  return { ...renderInApp(<RouterProvider router={router} />), router };
};

const renderOperatorPage = (data: PermissionsData, search = '') => renderInApp(
  <MemoryRouterProvider router={createMemoryRouter([{ path: '/permissions', Component: () => <OutcomeToastProvider><PermissionsWorkspace admin={false} initial={data} /></OutcomeToastProvider> }], { initialEntries: [`/permissions${search}`] })} />,
);

test('an operator sees every authorized principal in a read-only view', async () => {
  const view = renderOperatorPage(initial);
  const table = await screen.findByRole('table');
  expect(within(table).queryByRole('button', { name: 'Edit rule' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'New rule' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Delete rule' })).toBeNull();
  await waitFor(() => expect(screen.getByRole<HTMLInputElement>('combobox', { name: 'Applies to' }).value).toBe('All visible principals'));
  const picker = screen.getByRole('combobox', { name: 'Applies to' });
  fireEvent.click(picker);
  expect(await screen.findByRole('option', { name: /alice/ })).toBeTruthy();
  expect(await screen.findByRole('option', { name: /Platform/ })).toBeTruthy();
  expect(screen.getByRole('option', { name: 'All visible principals' })).toBeTruthy();
  expect(view.container.querySelectorAll('[data-rule-id]')).toHaveLength(3);
});

test('the permissions loader redirects an operator without Permission.Audit', async () => {
  useAuthStore.getState().primeFromLogin({
    token: 'operator-session',
    user: { id: 2, username: 'alice', isAdmin: false, canViewPermissions: false, canViewUpstreams: false, preferences: { quotaDisplay: 'remaining' as const, language: null } },
  });
  await expect(clientLoader()).rejects.toMatchObject({ status: 302 });
});

test('a non-admin URL naming an invisible principal never requests that principal\'s rules', async () => {
  const visible: PermissionsData = {
    ...initial,
    directory: { ...initial.directory!, users: initial.directory!.users.map(user => ({ ...user, groupIds: [] })), groups: [] },
    records: initial.records!.filter(record => record.principal.kind === 'user'),
  };
  const router = createMemoryRouter([{
    path: '/permissions',
    Component: () => <OutcomeToastProvider><PermissionsWorkspace key="mounted" admin={false} initial={visible} /></OutcomeToastProvider>,
  }], { initialEntries: ['/permissions?principal=user:1'] });
  renderInApp(<MemoryRouterProvider router={router} />);
  await waitFor(() => expect(screen.getByRole<HTMLInputElement>('combobox', { name: 'Applies to' }).value).toBe('All visible principals'), { timeout: 6_000 });
  expect(vi.mocked(fetch).mock.calls.every(([input]) => !String(input).includes('/access-resolve'))).toBe(true);
});

test.each([
  { principal: 'user:2:extra', scope: JSON.stringify(scope), removed: 'principal', retained: 'scope' },
  { principal: 'group:1', scope: 'not-json', removed: 'scope', retained: 'principal' },
])('replaces a malformed $removed URL filter while retaining $retained and search', async ({ principal, scope, removed, retained }) => {
  const search = new URLSearchParams({ principal, scope, q: 'Model.Use', effective: 'true', page: '4' });
  const { router } = renderPage(`?${search}`);
  await screen.findByRole('table');
  await waitFor(() => expect(new URLSearchParams(router.state.location.search).has(removed)).toBe(false));
  const params = new URLSearchParams(router.state.location.search);
  expect(params.get(retained)).toBe(search.get(retained));
  expect(params.get('q')).toBe('Model.Use');
  expect(params.has('page')).toBe(false);
  expect(params.has('effective')).toBe(false);
  expect(router.state.historyAction).toBe('REPLACE');
  expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes('/access-resolve'))).toBe(false);
});

test('a confirmed delete retires its rule and its confirmation without reading the page again', async () => {
  const originalFetch = vi.mocked(fetch).getMockImplementation()!;
  const requests: string[] = [];
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    requests.push(`${init?.method ?? 'GET'} ${path}`);
    if (path === '/api/access-records/2' && init?.method === 'DELETE') return Response.json({ ok: true });
    return originalFetch(input, init);
  }));
  const { container } = renderPage();
  await screen.findByRole('table');
  const reads = () => requests.filter(request => request.includes('/api/permissions')).length;
  const before = reads();
  const row = container.querySelector('[data-rule-id="2"]') as HTMLElement;
  await act(async () => { fireEvent.click(within(row).getByRole('button', { name: 'Delete rule' })); });
  const confirmation = screen.getByRole('dialog');
  await act(async () => { fireEvent.click(within(confirmation).getByRole('button', { name: 'Delete rule' })); });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(container.querySelector('[data-rule-id="2"]')).toBeNull();
  expect(container.querySelectorAll('[data-rule-id]')).toHaveLength(2);
  expect(reads()).toBe(before);
  expect(await screen.findByText('Deleted rule')).toBeTruthy();
});

test('locks all mutations while deleting and restores them after a failed write', async () => {
  const originalFetch = vi.mocked(fetch).getMockImplementation()!;
  let finish!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => init?.method === 'DELETE'
    ? new Promise<Response>(resolve => { finish = resolve; })
    : originalFetch(input, init)));
  const { container } = renderPage();
  const table = await screen.findByRole('table');
  const create = screen.getByRole<HTMLButtonElement>('button', { name: 'New rule' });
  const refresh = screen.getByRole<HTMLButtonElement>('button', { name: 'Refresh permissions' });
  const edit = screen.getAllByRole<HTMLButtonElement>('button', { name: 'Edit rule' });
  const row = container.querySelector('[data-rule-id="2"]') as HTMLElement;
  await act(async () => { fireEvent.click(within(row).getByRole('button', { name: 'Delete rule' })); });
  const confirmation = screen.getByRole('dialog');
  await act(async () => { fireEvent.click(within(confirmation).getByRole('button', { name: 'Delete rule' })); });
  expect(create.disabled).toBe(true);
  expect(refresh.disabled).toBe(true);
  expect(edit.every(button => button.disabled)).toBe(true);
  expect(table.isConnected).toBe(true);
  await act(async () => { finish(Response.json({ error: 'Delete failed' }, { status: 503 })); });
  await screen.findByText('Delete failed');
  expect(create.disabled).toBe(false);
  expect(table.isConnected).toBe(true);
});

test('effective toggle adds inherited rules and clearing the principal forces it off', async () => {
  const { container, router } = renderPage(`?principal=user:2&scope=${encodeURIComponent(JSON.stringify(scope))}`);
  await screen.findByRole('table');
  expect(container.querySelectorAll('[data-rule-id]')).toHaveLength(2);
  await act(async () => { fireEvent.click(screen.getByRole('switch', { name: 'Show effective' })); });
  await waitFor(() => expect(container.querySelectorAll('[data-rule-id]')).toHaveLength(3));
  expect(new URLSearchParams(router.state.location.search).get('effective')).toBe('true');
  expect(container.querySelector('[data-rule-id="2"] [data-permission-emphasis="overridden"]')).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Clear user or group filter' })); });
  await waitFor(() => expect(new URLSearchParams(router.state.location.search).has('effective')).toBe(false));
  const toggle = screen.getByRole<HTMLInputElement>('switch', { name: 'Show effective' });
  expect(toggle.disabled).toBe(true);
  expect(toggle.checked).toBe(false);
  expect(new URLSearchParams(router.state.location.search).get('scope')).toBe(JSON.stringify(scope));
});

test.each([false, true])('refresh preserves the table through base and effective reads (effective=%s)', async effective => {
  const { container } = renderPage(`?principal=user:2&scope=${encodeURIComponent(JSON.stringify(scope))}${effective ? '&effective=true' : ''}`);
  await screen.findByRole('table');
  await waitFor(() => expect(container.querySelectorAll('[data-rule-id]')).toHaveLength(effective ? 3 : 2));
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: 'New rule' }).disabled).toBe(false));
  const table = screen.getByRole('table');
  const rows = [...container.querySelectorAll('[data-rule-id]')];
  const contents = table.textContent;
  const fetch = globalThis.fetch;
  let finishRecords!: () => Promise<void>;
  let finishResolution!: () => Promise<void>;
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    if (path === '/api/permissions') return new Promise<Response>(resolve => { finishRecords = async () => resolve(await fetch(input, init)); });
    if (path === '/api/access-resolve') return new Promise<Response>(resolve => { finishResolution = async () => resolve(await fetch(input, init)); });
    return fetch(input, init);
  }));
  const retained = () => {
    expect(screen.getByRole('table')).toBe(table);
    expect([...container.querySelectorAll('[data-rule-id]')]).toEqual(rows);
    expect(table.textContent).toBe(contents);
    expect(within(table).getAllByRole<HTMLButtonElement>('button', { name: 'Edit rule' }).every(button => button.disabled)).toBe(true);
    expect(within(table).queryByRole('progressbar')).toBeNull();
    expect(table.closest('[aria-busy="true"]')).toBeTruthy();
  };
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Refresh permissions' })); });
  await waitFor(() => expect(finishRecords).toBeTypeOf('function'));
  retained();
  await act(async () => { await finishRecords(); });
  if (effective) {
    await waitFor(() => expect(finishResolution).toBeTypeOf('function'));
    retained();
    await act(async () => { await finishResolution(); });
  }
  await waitFor(() => expect(within(table).getAllByRole<HTMLButtonElement>('button', { name: 'Edit rule' }).every(button => !button.disabled)).toBe(true));
  expect(screen.getByRole('table')).toBe(table);
  expect(table.closest('[aria-busy="true"]')).toBeNull();
});
