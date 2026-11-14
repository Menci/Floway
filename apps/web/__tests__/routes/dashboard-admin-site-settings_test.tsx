import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { OutcomeToastProvider } from '../../src/components/ui/outcome-toast';
import DashboardAdminSiteSettings from '../../src/routes/dashboard-admin-site-settings';
import { useSiteSettingsStore } from '../../src/stores/site-settings-store';
import { renderInApp } from '../render';

beforeEach(() => useSiteSettingsStore.setState({ siteName: null, loaded: false }));
afterEach(() => vi.unstubAllGlobals());

const renderPage = (siteName: string | null) => {
  const loaderData = { siteName, error: null };
  return renderInApp(<RouterProvider router={createMemoryRouter([
    {
      path: '/',
      Component: () => <OutcomeToastProvider><Outlet /></OutcomeToastProvider>,
      children: [{
        index: true,
        Component: () => <DashboardAdminSiteSettings
          loaderData={loaderData}
          matches={[] as never}
          params={{}}
        />,
      }],
    },
  ], { initialEntries: ['/'] })} />);
};

it('renders the stored name and saves a trimmed replacement into the shared store', async () => {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    return Response.json({ site_name: 'Team Gateway' });
  }));
  const view = renderPage('Old Name');

  const input = view.container.querySelector('input')!;
  expect(input.value).toBe('Old Name');
  expect(input.placeholder).toBe('Floway');

  fireEvent.change(input, { target: { value: '  Team Gateway  ' } });
  await act(async () => { screen.getByRole('button', { name: 'Save' }).click(); });

  await waitFor(() => expect(useSiteSettingsStore.getState().siteName).toBe('Team Gateway'));
  expect(new URL(requests[0]!.url, 'http://localhost').pathname).toBe('/api/site-settings');
  expect(JSON.parse(String(requests[0]!.init?.body))).toEqual({ site_name: 'Team Gateway' });
});

it('clears the override when the field is emptied', async () => {
  const bodies: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ site_name: null });
  }));
  const view = renderPage('Old Name');

  fireEvent.change(view.container.querySelector('input')!, { target: { value: '   ' } });
  await act(async () => { screen.getByRole('button', { name: 'Save' }).click(); });

  await waitFor(() => expect(useSiteSettingsStore.getState().siteName).toBeNull());
  expect(bodies).toEqual([{ site_name: null }]);
});

it('reports a failed save instead of clearing the field', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'Unavailable' }, { status: 500 })));
  const view = renderPage('Old Name');

  await act(async () => { screen.getByRole('button', { name: 'Save' }).click(); });

  expect(await screen.findByText('Unavailable')).toBeTruthy();
  expect(view.container.querySelector('input')!.value).toBe('Old Name');
  expect(useSiteSettingsStore.getState().siteName).toBeNull();
});
