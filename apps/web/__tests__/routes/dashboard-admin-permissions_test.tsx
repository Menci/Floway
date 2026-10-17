import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useLoaderData } from 'react-router';
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
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'New rule' })); });
  // DialogShell mounts after the cold persistent editor module resolves.
  const dialog = await screen.findByRole('dialog', {}, { timeout: 5000 });
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
