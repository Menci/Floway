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

test('an operator clears a selected principal back to all visible principals', async () => {
  renderOperatorPage(initial);
  const picker = screen.getByRole<HTMLInputElement>('combobox', { name: 'Applies to' });
  await waitFor(() => expect(picker.value).toBe('All visible principals'));
  expect(screen.queryByRole('button', { name: 'Clear user or group filter' })).toBeNull();
  fireEvent.click(picker);
  fireEvent.click(await screen.findByRole('option', { name: /Platform/ }));
  await waitFor(() => expect(picker.value).toBe('Platform'));
  fireEvent.click(screen.getByRole('button', { name: 'Clear user or group filter' }));
  await waitFor(() => expect(picker.value).toBe('All visible principals'));
  expect(screen.queryByRole('button', { name: 'Clear user or group filter' })).toBeNull();
});

test('target-only identities render in rules without entering the principal picker', async () => {
  const data: PermissionsData = {
    ...initial,
    directory: {
      users: [...initial.directory!.users, { id: 3, username: 'bob', isAdmin: false, createdAt: '', preferences: { quotaDisplay: 'remaining' as const, language: null }, groupIds: [] }],
      groups: [...initial.directory!.groups, { id: 2, name: 'Review Subjects', hue: 180, memberIds: [3], createdAt: '', deletedAt: null }],
      principalUserIds: [2],
      principalGroupIds: [1],
    },
    records: [
      ...initial.records!,
      { id: 4, principal: { kind: 'user', id: 2 }, scope: { kind: 'user', userId: 3 }, sortOrder: 1, values: { 'User.Audit': true }, createdAt: '', updatedAt: '' },
      { id: 5, principal: { kind: 'group', id: 1 }, scope: { kind: 'group', groupId: 2 }, sortOrder: 1, values: { 'User.Audit': true }, createdAt: '', updatedAt: '' },
    ],
  };
  renderOperatorPage(data);
  const table = await screen.findByRole('table');
  expect(within(table).getByText('bob')).toBeTruthy();
  expect(within(table).getByText('Review Subjects')).toBeTruthy();
  const picker = screen.getByRole('combobox', { name: 'Applies to' });
  fireEvent.click(picker);
  expect(await screen.findByRole('option', { name: /alice/ })).toBeTruthy();
  expect(await screen.findByRole('option', { name: /Platform/ })).toBeTruthy();
  expect(screen.queryByRole('option', { name: /bob/ })).toBeNull();
  expect(screen.queryByRole('option', { name: /Review Subjects/ })).toBeNull();
});

test('an audited user sees membership-group rules and can pick those groups in Applies to', async () => {
  const data: PermissionsData = {
    ...initial,
    directory: {
      users: [{ id: 3, username: 'bob', isAdmin: false, createdAt: '', preferences: { quotaDisplay: 'remaining' as const, language: null }, groupIds: [2] }],
      groups: [{ id: 2, name: 'Review Subjects', hue: 180, memberIds: [3], createdAt: '', deletedAt: null }],
      principalUserIds: [3],
      principalGroupIds: [2],
    },
    records: [
      { id: 5, principal: { kind: 'user', id: 3 }, scope, sortOrder: 0, values: { 'Model.Use': true }, createdAt: '', updatedAt: '' },
    ],
  };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    if (path === '/api/permissions') return Response.json({ records: data.records, directory: data.directory, upstreams: data.upstreams });
    if (path === '/api/models') return Response.json({ data: [] });
    if (path === '/api/access-resolve') return Response.json({
      records: [
        data.records![0],
        { id: 6, principal: { kind: 'group', id: 2 }, scope, sortOrder: 0, values: { 'Model.Use': true }, createdAt: '', updatedAt: '' },
      ],
      values: { 'Model.Use': true, 'Upstream.Audit': false, 'Upstream.Edit': 'off' },
      decisions: [
        { recordId: 5, permissions: { 'Model.Use': { kind: 'effective' } } },
        { recordId: 6, permissions: { 'Model.Use': { kind: 'effective' } } },
      ],
    });
    throw new Error(`Unexpected request: ${path}`);
  }));
  const { container } = renderOperatorPage(data, `?principal=user:3&scope=${encodeURIComponent(JSON.stringify(scope))}&effective=true`);
  await screen.findByRole('table');
  await waitFor(() => expect(container.querySelectorAll('[data-rule-id]')).toHaveLength(2));
  expect(within(container.querySelector('[data-rule-id="6"]') as HTMLElement).getByText('Review Subjects')).toBeTruthy();
  const picker = screen.getByRole('combobox', { name: 'Applies to' });
  fireEvent.click(picker);
  expect(await screen.findByRole('option', { name: /bob/ })).toBeTruthy();
  expect(await screen.findByRole('option', { name: /Review Subjects/ })).toBeTruthy();
});

test('the permissions loader stays on the page for an authorized operator and requests one permission snapshot', async () => {
  useAuthStore.getState().primeFromLogin({
    token: 'operator-session',
    user: { id: 2, username: 'alice', isAdmin: false, canViewPermissions: true, canViewUpstreams: false, preferences: { quotaDisplay: 'remaining' as const, language: null } },
  });
  const data = await clientLoader();
  expect(data.admin).toBe(false);
  const requests = vi.mocked(fetch).mock.calls
    .map(([input]) => new URL(String(input), 'http://localhost'))
    .map(url => url.pathname);
  expect(requests).toEqual(['/api/permissions', '/api/models']);
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

test('a non-admin URL naming a group the operator does not belong to is normalized instead of treated as active', async () => {
  const router = createMemoryRouter([{
    path: '/permissions',
    Component: () => <OutcomeToastProvider><PermissionsWorkspace key="mounted" admin={false} initial={initial} /></OutcomeToastProvider>,
  }], { initialEntries: ['/permissions?principal=group:99'] });
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

test('invalid filters are replaced rather than retained in back navigation', async () => {
  const { router } = renderPage('?q=Audit');
  await screen.findByRole('table');
  await act(async () => { await router.navigate('/permissions?principal=bad&scope=bad&q=Model.Use&page=2'); });
  await waitFor(() => expect(router.state.location.search).toBe('?q=Model.Use'));
  expect(router.state.historyAction).toBe('REPLACE');
  await act(async () => { await router.navigate(-1); });
  expect(router.state.location.search).toBe('?q=Audit');
});

test('removing an invalid scope cancels its old draft and allows a fresh valid selection', async () => {
  const modelScope = { kind: 'upstreamModel', upstreamId: 'a', model: { kind: 'exact', value: 'gpt-5' } };
  const { container, router } = renderPage(`?principal=user:2&scope=${encodeURIComponent(JSON.stringify(modelScope))}`);
  await screen.findByText('No matching rules');
  const filters = container.querySelector('[data-permission-filters]') as HTMLElement;
  fireEvent.click(within(filters).getByRole('button', { name: 'gpt-5' }));
  const input = within(filters).getByRole('combobox', { name: 'Model' });
  fireEvent.change(input, { target: { value: 'uncommitted-model' } });
  await act(async () => {
    fireEvent.blur(input);
    await router.navigate('/permissions?principal=user:2&scope=bad&effective=true');
  });
  await waitFor(() => expect(new URLSearchParams(router.state.location.search).has('scope')).toBe(false));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(within(filters).queryByRole('combobox', { name: 'Model' })).toBeNull();
  expect(new URLSearchParams(router.state.location.search).has('scope')).toBe(false);
  await act(async () => { fireEvent.click(within(filters).getByRole('button', { name: 'Resource type' })); });
  await act(async () => { fireEvent.click(await screen.findByRole('option', { name: /^Upstream$/ })); });
  await act(async () => { fireEvent.click(await screen.findByRole('option', { name: 'Copilot' })); });
  await waitFor(() => expect(JSON.parse(new URLSearchParams(router.state.location.search).get('scope')!)).toEqual(scope));
  const toggle = screen.getByRole<HTMLInputElement>('switch', { name: 'Show effective' });
  expect(toggle.disabled).toBe(false);
  expect(toggle.checked).toBe(false);
});

test('removing an invalid principal preserves an unrelated in-progress scope draft', async () => {
  const modelScope = { kind: 'upstreamModel', upstreamId: 'a', model: { kind: 'exact', value: 'gpt-5' } };
  const { container, router } = renderPage(`?scope=${encodeURIComponent(JSON.stringify(modelScope))}`);
  await screen.findByText('No matching rules');
  const filters = container.querySelector('[data-permission-filters]') as HTMLElement;
  fireEvent.click(within(filters).getByRole('button', { name: 'gpt-5' }));
  const input = within(filters).getByRole<HTMLInputElement>('combobox', { name: 'Model' });
  fireEvent.change(input, { target: { value: 'draft-model' } });
  await act(async () => { await router.navigate(`/permissions?principal=bad&scope=${encodeURIComponent(JSON.stringify(modelScope))}`); });
  await waitFor(() => expect(new URLSearchParams(router.state.location.search).has('principal')).toBe(false));
  expect(within(filters).getByRole('combobox', { name: 'Model' })).toBe(input);
  expect(input.value).toBe('draft-model');
});

test('has one filter toolbar, subtitle and no tabs or redundant rule count', async () => {
  const { container } = renderPage('?effective=true');
  await screen.findByRole('table', { name: 'Permission rules' });
  expect(screen.getByText('Resource access for users and groups')).toBeTruthy();
  expect(screen.queryByRole('tablist')).toBeNull();
  expect(screen.queryByText(/^\d+ rules?$/)).toBeNull();
  expect(screen.getByRole('textbox', { name: 'Search rules' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'New rule' })).toBeTruthy();
  const toggle = screen.getByRole<HTMLInputElement>('switch', { name: 'Show effective' });
  expect(toggle.disabled).toBe(true);
  expect(toggle.checked).toBe(false);
  await act(async () => { fireEvent.click(container.querySelector('.fui-InfoButton')!); });
  expect(await screen.findByText('Checked:')).toBeTruthy();
  expect(screen.getByText('Unchecked:')).toBeTruthy();
  expect(screen.getByText(/inherited from ancestors/)).toBeTruthy();
  expect(screen.getByText(/its descendants/)).toBeTruthy();
  const checkedParagraph = screen.getByText('Checked:').closest('p')!;
  expect(checkedParagraph.parentElement!.children).toHaveLength(2);
  expect(checkedParagraph.parentElement!.querySelectorAll('p')).toHaveLength(2);
  expect(toggle.checked).toBe(false);
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

test('the root turns effective mode off and choosing a scope does not restore it', async () => {
  const { container, router } = renderPage('?principal=user:2&effective=true');
  await screen.findByRole('table');
  expect(container.querySelectorAll('[data-rule-id]')).toHaveLength(3);
  const toggle = screen.getByRole<HTMLInputElement>('switch', { name: 'Show effective' });
  expect(toggle.disabled).toBe(true);
  expect(toggle.checked).toBe(false);
  await waitFor(() => expect(new URLSearchParams(router.state.location.search).has('effective')).toBe(false));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Resource type' })); });
  await act(async () => { fireEvent.click(await screen.findByRole('option', { name: /^Upstream$/ })); });
  await waitFor(() => expect(toggle.disabled).toBe(false));
  expect(toggle.checked).toBe(false);
  expect(new URLSearchParams(router.state.location.search).has('effective')).toBe(false);
});

test('clearing an effective scope turns it off permanently when a scope is selected again', async () => {
  const { router } = renderPage(`?principal=user:2&scope=${encodeURIComponent(JSON.stringify(scope))}&effective=true`);
  await screen.findByRole('table');
  const toggle = screen.getByRole<HTMLInputElement>('switch', { name: 'Show effective' });
  expect(toggle.checked).toBe(true);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Remove last scope segment' })); });
  await waitFor(() => expect(JSON.parse(new URLSearchParams(router.state.location.search).get('scope')!)).toEqual({ kind: 'upstreams' }));
  expect(toggle.checked).toBe(true);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Remove last scope segment' })); });
  await waitFor(() => expect(toggle.disabled).toBe(true));
  expect(toggle.checked).toBe(false);
  expect(new URLSearchParams(router.state.location.search).has('effective')).toBe(false);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Resource type' })); });
  await act(async () => { fireEvent.click(await screen.findByRole('option', { name: /^Upstream$/ })); });
  await waitFor(() => expect(toggle.disabled).toBe(false));
  expect(toggle.checked).toBe(false);
});

test.each(['Upstream', 'Copilot'])('scope table part %s replaces the scope filter with its prefix', async name => {
  const { container, router } = renderPage('?principal=group:1&q=Model.Use');
  await screen.findByRole('table');
  const row = container.querySelector('[data-rule-id="2"]') as HTMLElement;
  await act(async () => { fireEvent.click(within(row).getByRole('button', { name })); });
  await waitFor(() => expect(JSON.parse(new URLSearchParams(router.state.location.search).get('scope')!)).toEqual(name === 'Upstream' ? { kind: 'upstreams' } : scope));
  const params = new URLSearchParams(router.state.location.search);
  expect(params.get('principal')).toBe('group:1');
  expect(params.get('q')).toBe('Model.Use');
  expect(screen.queryByRole('combobox', { name: 'Resource' })).toBeNull();
});

test('table scope navigation discards an active draft and cancels its deferred blur commit', async () => {
  const modelScope = { kind: 'upstreamModel', upstreamId: 'a', model: { kind: 'exact', value: 'gpt-5' } } as const;
  const data: PermissionsData = { ...initial, records: [...initial.records!, { ...initial.records![0]!, id: 4, scope: modelScope }] };
  const { container, router } = renderPage(`?scope=${encodeURIComponent(JSON.stringify(modelScope))}`, data);
  await screen.findByRole('table');
  const filters = container.querySelector('[data-permission-filters]') as HTMLElement;
  fireEvent.click(within(filters).getByRole('button', { name: 'gpt-5' }));
  const input = within(filters).getByRole('combobox', { name: 'Model' });
  fireEvent.change(input, { target: { value: 'uncommitted-model' } });
  const row = container.querySelector('[data-rule-id="4"]') as HTMLElement;
  await act(async () => {
    fireEvent.blur(input);
    fireEvent.click(within(row).getByRole('button', { name: 'gpt-5' }));
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  expect(JSON.parse(new URLSearchParams(router.state.location.search).get('scope')!)).toEqual(modelScope);
  expect(within(filters).queryByRole('combobox', { name: 'Model' })).toBeNull();
});

test('the Group scope prefix filters group scopes through a real /Groups URL scope', async () => {
  const data: PermissionsData = { ...initial, records: [...initial.records!, { ...initial.records![0]!, id: 4, scope: { kind: 'group', groupId: 1 }, values: { 'User.Audit': true } }] };
  const { container, router } = renderPage('', data);
  await screen.findByRole('table');
  const row = container.querySelector('[data-rule-id="4"]') as HTMLElement;
  await act(async () => { fireEvent.click(within(row).getByRole('button', { name: 'Group' })); });
  await waitFor(() => expect(JSON.parse(new URLSearchParams(router.state.location.search).get('scope')!)).toEqual({ kind: 'groups' }));
  expect(container.querySelectorAll('[data-rule-id]')).toHaveLength(1);
  expect(container.querySelector('[data-rule-id="4"]')).toBeTruthy();
  expect(within(container.querySelector('[data-permission-filters]') as HTMLElement).getByRole('button', { name: 'Group' })).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Remove last scope segment' })); });
  await waitFor(() => expect(new URLSearchParams(router.state.location.search).has('scope')).toBe(false));
  expect(container.querySelectorAll('[data-rule-id]')).toHaveLength(4);
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

test('search matches both displayed permission names and their code identifiers', async () => {
  const { container } = renderPage();
  await screen.findByRole('table');
  const input = screen.getByRole('textbox', { name: 'Search rules' });
  await act(async () => { fireEvent.change(input, { target: { value: 'Upstream.Audit' } }); });
  await waitFor(() => expect(container.querySelectorAll('[data-rule-id]')).toHaveLength(1));
  expect(container.querySelector('[data-rule-id="2"]')).toBeTruthy();
  await act(async () => { fireEvent.change(input, { target: { value: 'Use models' } }); });
  await waitFor(() => expect(container.querySelectorAll('[data-rule-id]')).toHaveLength(3));
});

test('new rule starts with the selected principal and scope', async () => {
  renderPage(`?principal=group:1&scope=${encodeURIComponent(JSON.stringify(scope))}`);
  await screen.findByRole('table');
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'New rule' }));
    await vi.dynamicImportSettled();
  });
  const dialog = await screen.findByRole('dialog');
  expect(dialog.querySelector<HTMLInputElement>('input[role="combobox"]')!.value).toBe('Platform');
  expect(dialog.querySelector('.floway-scope-expression')!.textContent).toContain('Copilot');
});

test('resolution errors stay visible and are not presented as an empty permission set', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'Resolution unavailable' }, { status: 503 })));
  renderPage(`?principal=user:2&scope=${encodeURIComponent(JSON.stringify(scope))}&effective=true`);
  expect(await screen.findByText('Resolution unavailable')).toBeTruthy();
  expect(screen.queryByText('No matching rules')).toBeNull();
  await act(async () => { fireEvent.click(screen.getByRole('switch', { name: 'Show effective' })); });
  expect(await screen.findByRole('table')).toBeTruthy();
});

test('a save refresh keeps the table and its controls available while it is in flight', async () => {
  const originalFetch = vi.mocked(fetch).getMockImplementation()!;
  let finishRefresh!: () => Promise<void>;
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    if (path.startsWith('/api/access-records/') && init?.method === 'PUT') return Response.json(initial.records![1]);
    if (path === '/api/permissions') return new Promise<Response>(resolve => { finishRefresh = async () => resolve(await originalFetch(input, init)); });
    return originalFetch(input, init);
  }));
  const { container } = renderPage();
  await screen.findByRole('table');
  const edit = screen.getAllByRole<HTMLButtonElement>('button', { name: 'Edit rule' }).find(button => !button.disabled)!;
  fireEvent.click(edit);
  const dialog = await screen.findByRole('dialog');
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Save rule' })); });
  await waitFor(() => expect(finishRefresh).toBeTypeOf('function'));
  expect(screen.getByRole('table')).toBeTruthy();
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'New rule' }).disabled).toBe(false);
  expect(container.querySelectorAll('[data-rule-id]')).toHaveLength(3);
  await act(async () => { await finishRefresh(); });
});

test('preview query parameters never expose design or example controls', async () => {
  renderPage('?permissionEditor=radio&inheritedIcon=branch');
  await screen.findByRole('table');
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'New rule' })); });
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).queryByRole('combobox', { name: 'Design' })).toBeNull();
  expect(within(dialog).queryByRole('combobox', { name: 'Example' })).toBeNull();
  expect(dialog.querySelector('[data-permission-preview-controls]')).toBeNull();
});

test('effective loading retains the existing table and disables its actions', async () => {
  const fetch = globalThis.fetch;
  let complete!: () => Promise<void>;
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>(resolve => {
    complete = async () => resolve(await fetch(input, init));
  })));
  const { container } = renderPage(`?principal=user:2&scope=${encodeURIComponent(JSON.stringify(scope))}`);
  const table = await screen.findByRole('table');
  const rows = [...container.querySelectorAll('[data-rule-id]')];
  await act(async () => { fireEvent.click(screen.getByRole('switch', { name: 'Show effective' })); });
  await waitFor(() => expect(complete).toBeTypeOf('function'));
  expect(screen.getByRole('table')).toBe(table);
  expect([...container.querySelectorAll('[data-rule-id]')]).toEqual(rows);
  expect(within(table).getAllByRole<HTMLButtonElement>('button', { name: 'Edit rule' }).every(button => button.disabled)).toBe(true);
  expect(within(table).queryByRole('progressbar')).toBeNull();
  await act(async () => { await complete(); });
  await waitFor(() => expect(container.querySelectorAll('[data-rule-id]')).toHaveLength(3));
  expect(screen.getByRole('table')).toBe(table);
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

test('an effective request preserves the displayed page until its results arrive', async () => {
  const models: NonNullable<PermissionsData['records']> = Array.from({ length: 42 }, (_, index) => ({
    ...initial.records![2]!, id: index + 100, sortOrder: index,
    scope: { kind: 'upstreamModel', upstreamId: 'a', model: { kind: 'exact', value: `model-${index}` } },
  }));
  const data = { ...initial, records: [...initial.records!, ...models] };
  const { container } = renderPage(`?principal=user:2&scope=${encodeURIComponent(JSON.stringify(scope))}&page=2`, data);
  const table = await screen.findByRole('table');
  const rows = [...container.querySelectorAll('[data-rule-id]')];
  expect(screen.getByText('21 - 40 / 44')).toBeTruthy();
  const fetch = globalThis.fetch;
  let complete!: () => Promise<void>;
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>(resolve => { complete = async () => resolve(await fetch(input, init)); })));
  await act(async () => { fireEvent.click(screen.getByRole('switch', { name: 'Show effective' })); });
  await waitFor(() => expect(complete).toBeTypeOf('function'));
  expect(screen.getByRole('table')).toBe(table);
  expect([...container.querySelectorAll('[data-rule-id]')]).toEqual(rows);
  expect(screen.getByText('21 - 40 / 44')).toBeTruthy();
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Next page' }).disabled).toBe(true);
  await act(async () => { await complete(); });
  await waitFor(() => expect(container.querySelectorAll('[data-rule-id]')).toHaveLength(3));
  expect(screen.queryByText('21 - 40 / 44')).toBeNull();
});

test('an initial effective read never displays descendant rules', async () => {
  const fetch = globalThis.fetch;
  let complete!: () => Promise<void>;
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>(resolve => { complete = async () => resolve(await fetch(input, init)); })));
  const descendant = { ...initial.records![0]!, id: 4, scope: { kind: 'upstreamModel' as const, upstreamId: 'a', model: { kind: 'exact' as const, value: 'gpt-5' } } };
  const { container } = renderPage(`?principal=user:2&scope=${encodeURIComponent(JSON.stringify(scope))}&effective=true`, { ...initial, records: [...initial.records!, descendant] });
  await screen.findByRole('table');
  await waitFor(() => expect(complete).toBeTypeOf('function'));
  expect([...container.querySelectorAll<HTMLElement>('[data-rule-id]')].map(row => row.dataset.ruleId)).toEqual(['1', '2', '3']);
  await act(async () => { await complete(); });
});
