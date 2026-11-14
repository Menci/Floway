import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { dashboardBucketFrames } from '../../src/components/charts/dashboard-time';
import { parsePerformanceUrlState, type PerformanceDisplayRecord, type PerformanceOverviewResponse } from '../../src/components/performance/overview';
import DashboardMonitorPerformance from '../../src/routes/dashboard-monitor-performance';
import { stubLocalStorage } from '../local-storage-stub';
import { renderInApp } from '../render';

stubLocalStorage();

afterEach(() => vi.unstubAllGlobals());

const loadedAt = Date.UTC(2026, 7, 5, 12);
const bucket = dashboardBucketFrames('today', loadedAt).at(-2)!.key;

const record = (group: string, values: Partial<PerformanceDisplayRecord> = {}): PerformanceDisplayRecord => ({
  bucket,
  group,
  requests: 1,
  errors: 0,
  ttftSamples: 1,
  tpotSamples: 1,
  neutral: 0,
  ttftMsP50: 100,
  ttftMsP95: 200,
  ttftMsP99: 300,
  tpotUsP50: 20_000,
  tpotUsP95: 40_000,
  tpotUsP99: 80_000,
  ...values,
});

const overview: PerformanceOverviewResponse = {
  series: [record('model-a'), record('model-b')],
  axes: {
    none: [],
    keyId: [],
    userId: [],
    model: [
      record('model-a', { requests: 2, ttftMsP50: 100, ttftMsP95: 400, ttftMsP99: 100 }),
      record('model-b', { requests: 9, ttftMsP50: 200, ttftMsP95: 300, ttftMsP99: 500 }),
    ],
    upstream: [],
    operation: [],
    runtimeLocation: [],
  },
  dimensionValues: { models: ['model-a', 'model-b'], upstreams: [], operations: [], runtimeLocations: [], keyIds: [], userIds: [] },
  users: [],
  upstreams: [],
  keys: [],
};

const renderPage = (search: string) => {
  const state = parsePerformanceUrlState(new URLSearchParams(search));
  const router = createMemoryRouter([{
    path: '/',
    Component: () => <DashboardMonitorPerformance
      loaderData={{
        currentUserId: '1',
        error: null,
        loadedAt,
        overview,
        regionAvailable: true,
        state,
      }}
      matches={[] as never}
      params={{}}
    />,
  }], { initialEntries: [`/?${search}`] });
  const view = renderInApp(<RouterProvider router={router} />);
  return { ...view, router };
};

const urlSearch = (router: ReturnType<typeof renderPage>['router']) => new URLSearchParams(router.state.location.search);

describe('Performance table state', () => {
  it('labels each table column with the percentile chosen for its metric', () => {
    renderPage('ttft_p=p99&speed_p=p50');

    expect(screen.getByRole('columnheader', { name: 'TTFT p99' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Worst 50% speed' })).toBeTruthy();
    expect(screen.getAllByRole('cell', { name: '500ms' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('cell', { name: '50.0 tok/s' }).length).toBeGreaterThan(0);
  });

  it('sorts the table by the percentile its column names', async () => {
    const { router } = renderPage('ttft_p=p95&sort=ttft');
    const modelOrder = () => screen.getAllByRole('row').slice(1).map(row => row.querySelector('td')?.textContent);

    expect(modelOrder()).toEqual(['model-a', 'model-b']);

    await act(async () => { fireEvent.click(screen.getByRole('radio', { name: 'p99' })); });
    await waitFor(() => expect(urlSearch(router).get('ttft_p')).toBe('p99'));
    expect(modelOrder()).toEqual(['model-b', 'model-a']);
  });

  it('reads each metric percentile independently when the chart metric changes', async () => {
    const { router } = renderPage('ttft_p=p99&speed_p=p50');

    await act(async () => { fireEvent.click(screen.getByRole('radio', { name: 'p50' })); });
    await waitFor(() => expect(urlSearch(router).get('ttft_p')).toBe('p50'));
    expect(urlSearch(router).get('speed_p')).toBe('p50');

    await act(async () => { fireEvent.click(screen.getByRole('radio', { name: 'Output speed' })); });
    await waitFor(() => expect(urlSearch(router).get('m')).toBe('tokPerSec'));
    expect(urlSearch(router).get('ttft_p')).toBe('p50');
    expect(urlSearch(router).get('speed_p')).toBe('p50');

    await act(async () => { fireEvent.click(screen.getByRole('radio', { name: 'p99' })); });
    await waitFor(() => expect(urlSearch(router).get('speed_p')).toBe('p99'));
    expect(urlSearch(router).get('ttft_p')).toBe('p50');
    expect(screen.getByRole('columnheader', { name: 'TTFT p50' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Worst 1% speed' })).toBeTruthy();
  });

  it('opens the breakdown and sort the URL names', () => {
    renderPage('tab=operation&sort=errors&dir=ascending');

    expect(screen.getByRole('tab', { name: 'By Operation' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('table', { name: 'By Operation' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Errors' }).getAttribute('aria-sort')).toBe('ascending');
  });

  it('writes the breakdown tab and table sort to the URL', async () => {
    const { router } = renderPage('');

    expect(screen.getByRole('tab', { name: 'By Upstream' })).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('tab', { name: 'By Operation' })); });
    await waitFor(() => expect(urlSearch(router).get('tab')).toBe('operation'));

    const errors = screen.getByRole('columnheader', { name: 'Errors' }).querySelector<HTMLElement>('[role=button]')!;
    await act(async () => { fireEvent.click(errors); });
    await waitFor(() => expect(urlSearch(router).get('sort')).toBe('errors'));
    expect(urlSearch(router).get('dir')).toBeNull();

    await act(async () => { fireEvent.click(errors); });
    await waitFor(() => expect(urlSearch(router).get('dir')).toBe('ascending'));
  });
});
