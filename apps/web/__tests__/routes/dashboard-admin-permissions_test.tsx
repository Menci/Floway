import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, useLoaderData } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { PermissionsData } from '../../src/components/access-control/data';
import { OutcomeToastProvider } from '../../src/components/ui/outcome-toast';
import DashboardAdminPermissions, { shouldRevalidate } from '../../src/routes/dashboard-admin-permissions';
import { renderInApp } from '../render';

vi.mock('../../src/components/ui/json-editor', () => ({ JsonEditor: () => null }));

const scope = { kind: 'upstream', upstreamId: 'a' } as const;
const initial: PermissionsData = {
  directory: {
    users: [{ id: 2, username: 'alice', isAdmin: false, createdAt: '', groupIds: [1], accessRecordCount: 1 }],
    groups: [{ id: 1, name: 'Platform', hue: 210, memberIds: [2], accessRecordCount: 2, createdAt: '', deletedAt: null }],
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
    if (path === '/api/access-records') return Response.json(initial.records);
    if (path === '/api/user-directory') return Response.json(initial.directory);
    if (path === '/api/models') return Response.json({ data: initial.models });
    if (path === '/api/upstream-options') return Response.json(initial.upstreams);
    throw new Error(`Unexpected request: ${path}`);
  }));
});
afterEach(() => vi.unstubAllGlobals());
const renderPage = (search = '', data = initial) => {
  const router = createMemoryRouter([{
    path: '/permissions', loader: () => data, shouldRevalidate,
    Component: () => <OutcomeToastProvider><DashboardAdminPermissions loaderData={useLoaderData() as never} params={{}} matches={[] as never} /></OutcomeToastProvider>,
  }], { initialEntries: [`/permissions${search}`] });
  return { ...renderInApp(<RouterProvider router={router} />), router };
};

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

test('the Group scope prefix filters group scopes through URL state', async () => {
  const data: PermissionsData = { ...initial, records: [...initial.records!, { ...initial.records![0]!, id: 4, scope: { kind: 'group', groupId: 1 }, values: { 'User.Audit': true } }] };
  const { container, router } = renderPage('', data);
  await screen.findByRole('table');
  const row = container.querySelector('[data-rule-id="4"]') as HTMLElement;
  await act(async () => { fireEvent.click(within(row).getByRole('button', { name: 'Group' })); });
  await waitFor(() => expect(new URLSearchParams(router.state.location.search).get('scopeKind')).toBe('group'));
  expect(container.querySelectorAll('[data-rule-id]')).toHaveLength(1);
  expect(container.querySelector('[data-rule-id="4"]')).toBeTruthy();
  expect(within(container.querySelector('[data-permission-filters]') as HTMLElement).getByRole('button', { name: 'Group' })).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Remove last scope segment' })); });
  await waitFor(() => expect(new URLSearchParams(router.state.location.search).has('scopeKind')).toBe(false));
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
    if (path === '/api/access-records') return new Promise<Response>(resolve => { finishRecords = async () => resolve(await fetch(input, init)); });
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
