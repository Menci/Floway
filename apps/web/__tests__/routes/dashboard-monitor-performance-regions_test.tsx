import { fireEvent, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PerformanceOverviewResponse } from '../../src/components/performance/overview';
import DashboardMonitorPerformance from '../../src/routes/dashboard-monitor-performance';
import { stubLocalStorage } from '../local-storage-stub';
import { renderInApp } from '../render';

stubLocalStorage();

afterEach(() => { vi.unstubAllGlobals(); });

const overview: PerformanceOverviewResponse = {
  series: [],
  axes: { none: [], keyId: [], userId: [], model: [], upstream: [], operation: [], runtimeLocation: [] },
  dimensionValues: { models: [], upstreams: [], operations: [], runtimeLocations: ['LOCAL'], keyIds: [], userIds: [] },
  users: [{ id: 5, username: 'Dana' }],
  upstreams: [],
  keys: [],
};

const renderPage = (regionAvailable: boolean | null, groupBy: 'model' | 'runtimeLocation' = 'model') => {
  const router = createMemoryRouter([{
    path: '/',
    Component: () => <DashboardMonitorPerformance
      loaderData={{
        currentUserId: '1',
        error: null,
        loadedAt: Date.UTC(2026, 7, 5, 12),
        overview,
        regionAvailable,
        state: {
          metric: 'ttft',
          percentile: 'p95',
          breakdown: 'model',
          sort: { key: 'requests', direction: 'descending' },
          groupBy,
          range: 'today',
          filters: { model: [], upstream: [], operation: [], runtimeLocation: [], userId: [], keyId: [] },
          hidden: [],
        },
      }}
      matches={[] as never}
      params={{}}
    />,
  }], { initialEntries: ['/'] });
  return renderInApp(<RouterProvider router={router} />);
};

describe('Performance Region dimensions', () => {
  it('does not turn an unauthorized URL user filter into a dropdown option', () => {
    const state = {
      metric: 'ttft' as const,
      percentile: 'p95' as const,
      breakdown: 'model' as const,
      sort: { key: 'requests' as const, direction: 'descending' as const },
      groupBy: 'model' as const,
      range: 'today' as const,
      filters: { model: [], upstream: [], operation: [], runtimeLocation: [], userId: ['999'], keyId: [] },
      hidden: [],
    };
    const router = createMemoryRouter([{
      path: '/',
      Component: () => <DashboardMonitorPerformance
        loaderData={{ currentUserId: '1', error: null, loadedAt: Date.UTC(2026, 7, 5, 12), overview, regionAvailable: false, state }}
        matches={[] as never}
        params={{}}
      />,
    }], { initialEntries: ['/'] });
    renderInApp(<RouterProvider router={router} />);

    fireEvent.click(screen.getByRole('combobox', { name: 'User' }));
    expect(screen.queryByRole('menuitemcheckbox', { name: 'user 999' })).toBeNull();
  });

  it('stays unavailable when the normalized overview fails', async () => {
    let overviewRequests = 0;
    let runtimeRequests = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost').pathname;
      if (path === '/api/runtime-info') {
        runtimeRequests += 1;
        return Response.json({ kind: 'node', runtimeLocation: 'LOCAL' });
      }
      if (path === '/api/performance/overview') {
        overviewRequests += 1;
        return overviewRequests === 1
          ? Response.json(overview)
          : Response.json({ error: 'Corrected overview failed' }, { status: 500 });
      }
      throw new Error(`Unexpected request to ${path}`);
    }));
    renderPage(null, 'runtimeLocation');

    fireEvent.click(screen.getByRole('button', { name: 'Refresh performance' }));

    await waitFor(() => expect(screen.getByText('Corrected overview failed')).toBeTruthy());
    expect(screen.getByText('This view could not be loaded')).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'Group by' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh performance' }));
    await waitFor(() => expect(overviewRequests).toBe(3));
    expect(runtimeRequests).toBe(1);
  });
});
