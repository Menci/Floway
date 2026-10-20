import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, Outlet, RouterProvider, useLoaderData } from 'react-router';
import { afterEach, expect, test, vi } from 'vitest';

import type { ControlPlaneGroup, ControlPlaneUser } from '../../src/api/types';
import { OutcomeToastProvider } from '../../src/components/ui/outcome-toast';
import { shortDate } from '../../src/lib/format-time';
import DashboardAdminUsers, { shouldRevalidate } from '../../src/routes/dashboard-admin-users';
import { renderInApp } from '../render';

const groups: ControlPlaneGroup[] = [
  { id: 1, name: 'Platform', hue: 210, createdAt: '2026-10-01T00:00:00Z', deletedAt: null },
  { id: 2, name: 'Research', hue: 150, createdAt: '2026-10-01T00:00:00Z', deletedAt: null },
];
const user: ControlPlaneUser = { id: 1, username: 'frank', isAdmin: true, createdAt: '2026-10-01T00:00:00Z', preferences: { quotaDisplay: 'remaining', language: null } };
const memberships = [
  { groupId: 1, userId: 1, createdAt: '2026-10-10T09:30:00Z' },
  { groupId: 2, userId: 1, createdAt: '2026-10-12T10:00:00Z' },
];
const loaderData = { directory: { users: [user], groups, memberships }, error: null };

afterEach(() => vi.restoreAllMocks());

const renderPage = (entry = '/dashboard/admin/users', data = loaderData, availableWidth = 1000) => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return new DOMRect(0, 0, this.hasAttribute('data-measure-group') ? 100 : this.hasAttribute('data-measure-overflow') ? 24 : availableWidth, 24);
  });
  const readStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
    const style = readStyle(element, pseudo);
    if (element.hasAttribute('data-group-memberships')) Object.defineProperty(style, 'columnGap', { value: '8px' });
    return style;
  });
  const loader = vi.fn(() => data);
  const router = createMemoryRouter([{
    path: '/dashboard', element: <OutcomeToastProvider><Outlet context={{ user }} /></OutcomeToastProvider>, children: [{
      path: 'admin/users', loader, shouldRevalidate,
      Component: () => <DashboardAdminUsers loaderData={useLoaderData() as never} params={{}} matches={[] as never} />,
    }],
  }], { initialEntries: [entry] });
  const view = renderInApp(<RouterProvider router={router} />);
  return { ...view, loader, router };
};

test('opens a group deep link and keeps group selection in browser history', async () => {
  const { loader, router } = renderPage('/dashboard/admin/users?tab=groups&group=2');
  const selected = await screen.findByRole('option', { name: 'Research' });
  expect(selected.getAttribute('aria-selected')).toBe('true');
  expect(selected.querySelector('.floway-identity .floway-group-avatar')).not.toBeNull();
  expect(screen.getByRole('table').querySelector('.floway-identity .floway-avatar-initials')?.textContent).toBe('F');
  await act(async () => { fireEvent.click(screen.getByRole('option', { name: 'Platform' })); });
  await waitFor(() => expect(new URLSearchParams(router.state.location.search).get('group')).toBe('1'));
  await act(async () => { await router.navigate(-1); });
  expect(screen.getByRole('option', { name: 'Research' }).getAttribute('aria-selected')).toBe('true');
  expect(loader).toHaveBeenCalledOnce();
});

test('navigates from a group identity to its roster without carrying the user search', async () => {
  const { router } = renderPage();
  const search = await screen.findByRole('textbox', { name: 'Search users' });
  fireEvent.change(search, { target: { value: 'frank' } });
  const link = screen.getByRole('link', { name: 'Research' });
  expect(link.querySelector('.floway-identity .floway-group-avatar')).not.toBeNull();
  expect(link.querySelector('.fui-Tag')).toBeNull();
  expect(link.getAttribute('href')).toBe('/dashboard/admin/users?tab=groups&group=2');
  await act(async () => { fireEvent.click(link); });
  await waitFor(() => expect(router.state.location.search).toBe('?tab=groups&group=2'));
  expect(screen.getByRole('option', { name: 'Research' }).getAttribute('aria-selected')).toBe('true');
  expect((screen.getByRole('textbox', { name: 'Search groups' }) as HTMLInputElement).value).toBe('');
});

test.each(['', '&group=999', '&group=invalid'])('canonicalizes an unavailable selection%s to the displayed group', async query => {
  const { router } = renderPage(`/dashboard/admin/users?tab=groups${query}`);
  await waitFor(() => expect(new URLSearchParams(router.state.location.search).get('group')).toBe('1'));
  expect(screen.getByRole('option', { name: 'Platform' }).getAttribute('aria-selected')).toBe('true');
});

test('retains the selected group when switching tabs', async () => {
  const { router } = renderPage('/dashboard/admin/users?tab=groups&group=2');
  await screen.findByRole('option', { name: 'Research' });
  await act(async () => { fireEvent.click(screen.getByRole('tab', { name: /^Users/ })); });
  expect(new URLSearchParams(router.state.location.search).get('tab')).toBeNull();
  expect(new URLSearchParams(router.state.location.search).get('group')).toBe('2');
  await act(async () => { fireEvent.click(screen.getByRole('tab', { name: /^Groups/ })); });
  expect(screen.getByRole('option', { name: 'Research' }).getAttribute('aria-selected')).toBe('true');
});

test('clears the unavailable group address when no groups remain', async () => {
  const { router } = renderPage('/dashboard/admin/users?tab=groups&group=2', { ...loaderData, directory: { users: [user], groups: [], memberships: [] } });
  await waitFor(() => expect(new URLSearchParams(router.state.location.search).get('group')).toBeNull());
  expect(screen.getByText('No groups found')).toBeTruthy();
});

test('does not repeat an untruncated username on hover', async () => {
  renderPage();
  const name = await screen.findByRole('button', { name: 'frank' });
  fireEvent.pointerEnter(name.querySelector('.floway-identity-name')!, { pointerType: 'mouse' });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 500)); });
  expect(screen.queryByRole('tooltip')).toBeNull();
});

test('opens hidden group links from the overflow control', async () => {
  const { router } = renderPage('/dashboard/admin/users', loaderData, 80);
  await screen.findByRole('button', { name: 'frank' });
  const overflow = await screen.findByRole('button', { name: 'Show 2 more groups' });
  expect(overflow.querySelector('.floway-group-avatar[data-overflow-count="2"]')?.textContent).toBe('+2');
  expect(overflow.querySelector('.fui-Avatar')?.getAttribute('data-winui-avatar-color')).toBe('neutral');
  expect(overflow.querySelector('.fui-Tag')).toBeNull();
  await act(async () => { fireEvent.click(overflow); });
  expect(screen.getByRole('group', { name: 'Groups' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Research' }).getAttribute('href')).toBe('/dashboard/admin/users?tab=groups&group=2');
  await act(async () => { fireEvent.click(screen.getByRole('link', { name: 'Research' })); });
  await waitFor(() => expect(new URLSearchParams(router.state.location.search).get('group')).toBe('2'));
  expect(screen.getByRole('option', { name: 'Research' }).getAttribute('aria-selected')).toBe('true');
});

test('retains the complete directory and edit membership when refreshing it fails', async () => {
  const requested: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const path = new URL(String(input), 'http://localhost').pathname;
    requested.push(path);
    if (path === '/api/user-directory') return Response.json({ error: 'Directory unavailable' }, { status: 503 });
    throw new Error(`Unexpected request: ${path}`);
  });
  renderPage();
  await screen.findByRole('button', { name: 'frank' });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Refresh users and groups' })); });
  await screen.findByText('Directory unavailable');
  expect(screen.getByRole('link', { name: 'Platform' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Research' })).toBeTruthy();
  expect(requested).toEqual(['/api/user-directory']);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'frank' })); });
  const dialog = screen.getByRole('dialog');
  expect(dialog.textContent).toContain('Platform');
  expect(dialog.textContent).toContain('Research');
});

test('keeps account dates visible and locks every editor during refresh', async () => {
  let finish!: (response: Response) => void;
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  renderPage();
  const name = await screen.findByRole<HTMLButtonElement>('button', { name: 'frank' });
  expect(screen.getByRole('columnheader', { name: 'Created' })).toBeTruthy();
  expect(screen.queryByRole('columnheader', { name: 'Role' })).toBeNull();
  expect(name.getAttribute('aria-description')).toBe('Administrator');
  const table = screen.getByRole('table');
  expect(screen.getAllByRole('columnheader').at(-1)?.textContent).toBe('');
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Refresh users and groups' })); });
  expect(name.disabled).toBe(true);
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Edit user frank' }).disabled).toBe(true);
  fireEvent.click(name);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByRole('table')).toBe(table);
  await act(async () => { finish(Response.json(loaderData.directory)); });
  await waitFor(() => expect(name.disabled).toBe(false));
});

test('changing groups discards an open member removal confirmation', async () => {
  const { router } = renderPage('/dashboard/admin/users?tab=groups&group=1');
  await screen.findByRole('option', { name: 'Platform' });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Remove frank from group' })); });
  await screen.findByRole('dialog', { name: 'Remove member' });
  await act(async () => { await router.navigate('/dashboard/admin/users?tab=groups&group=2'); });
  expect(screen.queryByRole('dialog', { name: 'Remove member' })).toBeNull();
});

test('refreshes both membership directions from the same directory response', async () => {
  const group = { ...groups[0], id: 3, name: 'New group' };
  const updated = { users: [user], groups: [group], memberships: [{ ...memberships[0], groupId: 3 }] };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const path = new URL(String(input), 'http://localhost').pathname;
    if (path === '/api/user-directory') return Response.json(updated);
    throw new Error(`Unexpected request: ${path}`);
  });
  renderPage();
  await screen.findByRole('button', { name: 'frank' });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Refresh users and groups' })); });
  await screen.findByRole('link', { name: 'New group' });
  expect(screen.queryByRole('link', { name: 'Platform' })).toBeNull();
  await act(async () => { fireEvent.click(screen.getByRole('tab', { name: /^Groups/ })); });
  expect(screen.getByRole('option', { name: 'New group' }).getAttribute('aria-selected')).toBe('true');
  expect(screen.getByRole('table').textContent).toContain('frank');
});

test('keeps an open user editor paired with the group metadata it was opened with', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const path = new URL(String(input), 'http://localhost').pathname;
    if (path === '/api/user-directory') return Response.json({ users: [user], groups: [], memberships: [] });
    throw new Error(`Unexpected request: ${path}`);
  });
  renderPage();
  const name = await screen.findByRole('button', { name: 'frank' });
  const refresh = screen.getByRole('button', { name: 'Refresh users and groups' });
  const groupTab = screen.getByRole('tab', { name: /^Groups/ });
  await act(async () => { fireEvent.click(name); });
  expect(screen.getByRole('dialog').textContent).toContain('Research');
  await act(async () => { fireEvent.click(refresh); });
  await waitFor(() => expect(groupTab.querySelector('.proportional-nums')?.textContent).toBe('0'));
  expect(screen.getByRole('dialog').textContent).toContain('Platform');
  expect(screen.getByRole('dialog').textContent).toContain('Research');
});

test('shows account creation dates and an administrator icon beside the username', async () => {
  const { container } = renderPage();
  const name = await screen.findByRole('button', { name: 'frank' });
  expect(screen.queryByRole('columnheader', { name: 'Role' })).toBeNull();
  expect(screen.getByRole('columnheader', { name: 'Created' })).toBeTruthy();
  expect(container.querySelector('time')?.getAttribute('datetime')).toBe(user.createdAt);
  expect(name.querySelector('.floway-admin-indicator')?.getAttribute('aria-label')).toBe('Administrator');
});

test('shows membership dates and group creation metadata without a separator glyph', async () => {
  const { container } = renderPage('/dashboard/admin/users?tab=groups&group=1');
  await screen.findByRole('option', { name: 'Platform' });
  const table = screen.getByRole('table');
  expect(screen.queryByRole('columnheader', { name: 'Role' })).toBeNull();
  expect(screen.getByRole('columnheader', { name: 'Joined' })).toBeTruthy();
  expect(table.querySelector('time')?.getAttribute('datetime')).toBe(memberships[0]!.createdAt);
  expect(screen.getByText(`Created ${shortDate(groups[0]!.createdAt, 'en')}`)).toBeTruthy();
  expect(container.querySelector('section.grid > header')!.textContent).not.toContain('\u00b7');
});

test('keeps creation metadata in empty group details', async () => {
  const empty = { ...groups[0]!, id: 3, name: 'Archive' };
  renderPage('/dashboard/admin/users?tab=groups&group=3', { ...loaderData, directory: { ...loaderData.directory, groups: [...groups, empty] } });
  await screen.findByRole('option', { name: 'Archive' });
  expect(screen.getByText('0 members')).toBeTruthy();
  expect(screen.getByText(`Created ${shortDate(empty.createdAt, 'en')}`)).toBeTruthy();
  expect(screen.getByText('This group has no members')).toBeTruthy();
  expect(screen.queryByRole('table')).toBeNull();
});
