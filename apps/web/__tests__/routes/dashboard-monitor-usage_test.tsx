import { screen } from '@testing-library/react';
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';

import DashboardMonitorUsage from '../../src/routes/dashboard-monitor-usage';
import { renderInApp } from '../render';

const loadedAt = Date.UTC(2026, 7, 5, 12);
const loaderData = {
  error: null,
  filters: { identity: [], model: [], upstream: [] },
  groupBy: 'identity' as const,
  hiddenKeys: [],
  hiddenModels: [],
  hiddenUpstreams: [],
  loadedAt,
  metric: 'total' as const,
  models: [{ id: 'gpt-5', object: 'model' as const, created: 0, owned_by: 'floway', kind: 'chat' as const, upstreams: [] }],
  range: 'today' as const,
  redactKeys: false,
  search: { records: [], keys: [] },
  upstreams: [{ id: 'up-1', name: 'Copilot seat' }],
  usage: {
    keys: [{ id: 'user-2', name: 'Alice' }],
    records: [{
      keyId: 'user-2',
      model: 'gpt-5',
      upstream: 'up-1',
      hour: '2026-08-05T11',
      requests: 1,
      metrics: { input_tokens: '10' as const },
      cost: null,
    }],
  },
  view: 'all-by-user' as const,
};

describe('usage dimension controls', () => {
  it('renders one token chart for the selected grouping', () => {
    const user = { id: 1, username: 'admin', isAdmin: true, upstreamIds: null };
    const router = createMemoryRouter([{
      path: '/',
      Component: () => <Outlet context={{ user }} />,
      children: [{
        index: true,
        Component: () => <DashboardMonitorUsage loaderData={loaderData} matches={[] as never} params={{}} />,
      }],
    }], { initialEntries: ['/'] });

    renderInApp(<RouterProvider router={router} />);

    expect(screen.getByRole<HTMLInputElement>('combobox', { name: 'Group by' }).value).toBe('By User');
    expect(screen.getByRole('combobox', { name: 'Model' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Upstream' })).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'User' })).toBeNull();
    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 2, name: 'By User' })).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 2, name: 'By Model' })).toBeNull();
  });
});
