import { screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';

import type { PerformanceOverviewResponse } from '../../src/components/performance/overview';
import DashboardMonitorPerformance from '../../src/routes/dashboard-monitor-performance';
import { renderInApp } from '../render';

const overview: PerformanceOverviewResponse = {
  series: [],
  axes: { none: [], keyId: [], userId: [], model: [], upstream: [], operation: [], runtimeLocation: [] },
  dimensionValues: { models: [], upstreams: [], operations: [], runtimeLocations: ['LOCAL'], keyIds: [], userIds: [] },
  users: [],
  keys: [],
};

const renderPage = (regionAvailable: boolean) => {
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
});
