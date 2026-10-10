import { fireEvent, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';

import DashboardMonitorUpstreamUsage, { clientLoader } from '../../src/routes/dashboard-monitor-upstream-usage';
import { useAuthStore } from '../../src/stores/auth-store';
import { stubLocalStorage } from '../local-storage-stub';
import { renderInApp } from '../render';

stubLocalStorage();
afterEach(() => { useAuthStore.getState().clear(); vi.unstubAllGlobals(); });
const loadedAt = Date.UTC(2026, 9, 10, 12);
const loaderData = {
  range: 'today' as const, groupBy: 'upstream' as const, selectedUpstream: null as string | null, selectedMetric: null as string | null, loadedAt,
  result: { data: { start: loadedAt - 86_400_000, end: loadedAt, records: [{ upstreamId: 'up-1', key: 'premium_interactions', value: 25, timestamp: loadedAt - 60_000, provider: 'copilot' as const, upstreamName: 'Copilot seat', upstreamHue: 210 }] } },
};
const renderPage = (data: Parameters<typeof DashboardMonitorUpstreamUsage>[0]['loaderData']) => {
  const router = createMemoryRouter([{ path: '/', Component: () => <DashboardMonitorUpstreamUsage loaderData={data} matches={[] as never} params={{}} /> }]);
  return renderInApp(<RouterProvider router={router} />);
};

it('offers a single selected comparison and date ranges in one control row', async () => {
  renderPage(loaderData);
  expect(screen.getAllByRole('combobox')).toHaveLength(2);
  expect(screen.getByRole('combobox', { name: 'Upstream' })).toBeTruthy();
  expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(1);
  expect(screen.getByRole('radiogroup', { name: 'Usage range' })).toBeTruthy();
  expect(screen.getByText('Last Day')).toBeTruthy();
  expect(screen.getByText('7 Days')).toBeTruthy();
  expect(screen.getByText('30 Days')).toBeTruthy();
  expect(screen.getByText('Custom')).toBeTruthy();
  expect(screen.getByRole('heading', { level: 2, name: 'Copilot seat' })).toBeTruthy();
  fireEvent.click(screen.getByRole('combobox', { name: 'Group by' }));
  fireEvent.click(screen.getByRole('option', { name: 'Metric' }));
  await waitFor(() => expect(screen.getByRole('heading', { level: 2, name: 'Premium interactions' })).toBeTruthy());
  expect(screen.getByRole('combobox', { name: 'Metric' })).toBeTruthy();
  expect(screen.queryByRole('combobox', { name: 'Upstream' })).toBeNull();
});

it('renders fetch failure separately from a successful empty query', () => {
  renderPage({ ...loaderData, result: { error: { status: 500, message: 'Usage storage unavailable' } } });
  expect(screen.getByText('Usage storage unavailable')).toBeTruthy();
  expect(screen.getByText('This view could not be loaded')).toBeTruthy();
  expect(screen.queryByText('No upstream usage observations in this range')).toBeNull();
});

it('refuses non-admin navigation before requesting subscription history', async () => {
  useAuthStore.getState().primeFromLogin({ token: 'session', user: { id: 2, username: 'user', isAdmin: false, upstreamIds: null } });
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  await expect(clientLoader({ request: new Request('http://localhost/dashboard/monitor/upstream-usage') } as never)).rejects.toMatchObject({ status: 302 });
  expect(fetch).not.toHaveBeenCalled();
});

it('changes the selected upstream without displaying additional charts', async () => {
  const first = loaderData.result.data.records[0]!;
  renderPage({ ...loaderData, result: { data: { ...loaderData.result.data, records: [first, { ...first, upstreamId: 'up-2', upstreamName: 'Second seat', value: 40 }] } } });
  fireEvent.click(screen.getByRole('combobox', { name: 'Upstream' }));
  fireEvent.click(screen.getByRole('option', { name: 'Second seat' }));
  await waitFor(() => expect(screen.getByRole('heading', { level: 2, name: 'Second seat' })).toBeTruthy());
  expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(1);
  expect(screen.queryByRole('heading', { name: 'Copilot seat' })).toBeNull();
});
