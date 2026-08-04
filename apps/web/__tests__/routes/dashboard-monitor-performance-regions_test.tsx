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
  users: [],
  keys: [],
};

const renderPage = (regionAvailable: boolean | null) => {
  const router = createMemoryRouter([{
    path: '/',
    Component: () => <DashboardMonitorPerformance
      loaderData={{
        error: null,
        loadedAt: Date.UTC(2026, 7, 5, 12),
        overview,
        regionAvailable,
        state: {
          metric: 'ttft',
          percentile: 'p95',
          groupBy: 'model',
          range: 'today',
          filters: { model: [], upstream: [], operation: [], runtimeLocation: [], userId: [], keyId: [] },
          hidden: [],
        },
        upstreamNames: [],
        view: 'self-by-key',
      }}
      matches={[] as never}
      params={{}}
    />,
  }], { initialEntries: ['/'] });
  return renderInApp(<RouterProvider router={router} />);
};

describe('Performance Region dimensions', () => {
  it('hides Region controls and breakdowns outside Cloudflare', () => {
    renderPage(false);

    expect(screen.queryByRole('combobox', { name: 'Region' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'By Region' })).toBeNull();
  });

  it('keeps Region controls and breakdowns on Cloudflare', () => {
    renderPage(true);

    expect(screen.getByRole('combobox', { name: 'Region' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'By Region' })).toBeTruthy();
  });

  it('retries an unknown runtime through the page refresh action', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost').pathname;
      if (path === '/api/runtime-info') return Response.json({ kind: 'node', runtimeLocation: 'LOCAL' });
      if (path === '/api/performance/overview') return Response.json(overview);
      throw new Error(`Unexpected request to ${path}`);
    }));
    renderPage(null);

    expect(screen.getByText('This view could not be loaded')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh performance' }));

    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Group by' })).toBeTruthy());
    expect(screen.queryByRole('combobox', { name: 'Region' })).toBeNull();
  });

  it('keeps a known Node capability through a later probe failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost').pathname;
      if (path === '/api/runtime-info') return Response.json({ error: 'Unavailable' }, { status: 500 });
      if (path === '/api/performance/overview') return Response.json(overview);
      throw new Error(`Unexpected request to ${path}`);
    }));
    renderPage(false);

    fireEvent.click(screen.getByRole('button', { name: 'Refresh performance' }));

    await waitFor(() => expect(screen.getByText('Unavailable')).toBeTruthy());
    expect(screen.getByRole('combobox', { name: 'Group by' })).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'Region' })).toBeNull();
  });
});
