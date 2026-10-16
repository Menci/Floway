import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, Outlet, RouterProvider, useLoaderData } from 'react-router';
import { afterEach, expect, test, vi } from 'vitest';

import type { ControlPlaneGroup, ControlPlaneUser } from '../../src/api/types';
import { OutcomeToastProvider } from '../../src/components/ui/outcome-toast';
import DashboardAdminUsers from '../../src/routes/dashboard-admin-users';
import { renderInApp } from '../render';

const groups: ControlPlaneGroup[] = [
  { id: 1, name: 'Platform', hue: 210, memberIds: [1], createdAt: '2026-10-01T00:00:00Z', deletedAt: null },
  { id: 2, name: 'Research', hue: 150, memberIds: [1], createdAt: '2026-10-01T00:00:00Z', deletedAt: null },
];
const user: ControlPlaneUser = { id: 1, username: 'frank', isAdmin: true, upstreamIds: null, groupIds: [1, 2], createdAt: '2026-10-01T00:00:00Z' };
const loaderData = { users: [user], groups, models: [], upstreams: [], error: null };

afterEach(() => vi.restoreAllMocks());

const renderPage = (entry = '/dashboard/admin/users', data = loaderData) => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return new DOMRect(0, 0, this.hasAttribute('data-measure-badge') ? 100 : this.hasAttribute('data-measure-overflow') ? 30 : 1000, 24);
  });
  const readStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
    const style = readStyle(element, pseudo);
    if (element.hasAttribute('data-group-badges')) Object.defineProperty(style, 'columnGap', { value: '4px' });
    return style;
  });
  const router = createMemoryRouter([{
    path: '/dashboard', element: <OutcomeToastProvider><Outlet context={{ user }} /></OutcomeToastProvider>, children: [{
      path: 'admin/users', loader: () => data,
      Component: () => <DashboardAdminUsers loaderData={useLoaderData() as never} params={{}} matches={[] as never} />,
    }],
  }], { initialEntries: [entry] });
  const view = renderInApp(<RouterProvider router={router} />);
  return { ...view, router };
};

test('opens a group deep link and keeps group selection in browser history', async () => {
  const { router } = renderPage('/dashboard/admin/users?tab=groups&group=2');
  expect((await screen.findByRole('option', { name: 'Research' })).getAttribute('aria-selected')).toBe('true');
  await act(async () => { fireEvent.click(screen.getByRole('option', { name: 'Platform' })); });
  await waitFor(() => expect(new URLSearchParams(router.state.location.search).get('group')).toBe('1'));
  await act(async () => { await router.navigate(-1); });
  expect(screen.getByRole('option', { name: 'Research' }).getAttribute('aria-selected')).toBe('true');
});

test('navigates from a user group badge to its roster without carrying the user search', async () => {
  const { router } = renderPage();
  const search = await screen.findByRole('textbox', { name: 'Search users' });
  fireEvent.change(search, { target: { value: 'frank' } });
  const link = screen.getByRole('link', { name: 'Research' });
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
  const { router } = renderPage('/dashboard/admin/users?tab=groups&group=2', { ...loaderData, groups: [] });
  await waitFor(() => expect(new URLSearchParams(router.state.location.search).get('group')).toBeNull());
  expect(screen.getByText('No groups found')).toBeTruthy();
});

test('does not repeat an untruncated username on hover', async () => {
  renderPage();
  const name = await screen.findByRole('button', { name: 'frank' });
  fireEvent.pointerEnter(name, { pointerType: 'mouse' });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 500)); });
  expect(screen.queryByRole('tooltip')).toBeNull();
});

test('opens hidden group links from the overflow control', async () => {
  const { router } = renderPage();
  await screen.findByRole('button', { name: 'frank' });
  vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue(new DOMRect(0, 0, 20, 24));
  fireEvent.change(screen.getByRole('textbox', { name: 'Search users' }), { target: { value: 'frank' } });
  await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Show 2 more groups' })); });
  expect(screen.getByRole('group', { name: 'Groups' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Research' }).getAttribute('href')).toBe('/dashboard/admin/users?tab=groups&group=2');
  await act(async () => { fireEvent.click(screen.getByRole('link', { name: 'Research' })); });
  await waitFor(() => expect(new URLSearchParams(router.state.location.search).get('group')).toBe('2'));
  expect(screen.getByRole('option', { name: 'Research' }).getAttribute('aria-selected')).toBe('true');
});
