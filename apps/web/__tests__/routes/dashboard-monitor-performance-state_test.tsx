import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
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
    none: [record('')],
    keyId: [],
    userId: [],
    model: [
      record('model-a', { requests: 2, ttftMsP50: 100, ttftMsP95: 400, ttftMsP99: 450, tpotUsP50: 10_000, tpotUsP95: 50_000, tpotUsP99: 60_000 }),
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

const renderPage = (search: string, data = overview) => {
  const state = parsePerformanceUrlState(new URLSearchParams(search));
  const router = createMemoryRouter([{
    path: '/',
    Component: () => <DashboardMonitorPerformance
      loaderData={{
        currentUserId: '1',
        error: null,
        loadedAt,
        overview: data,
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
  it.each(['ttft', 'tokPerSec'] as const)('updates both table metrics for every percentile with chart %s', async metric => {
    const data = { ...overview, axes: { ...overview.axes, model: [record('model-a')] } };
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    renderPage(`m=${metric}`, data);
    const group = 'By Model';
    const table = within(screen.getByRole('table', { name: group }));
    const summary = () => screen.getByText('Speed p50').parentElement!.parentElement!.textContent;
    const initialSummary = summary();
    expect(initialSummary).toContain('50.0 tok/s');

    for (const [percentile, tail, latency, speed] of [
      ['p50', 50, '100ms', '50.0 tok/s'],
      ['p99', 1, '300ms', '12.5 tok/s'],
      ['p95', 5, '200ms', '25.0 tok/s'],
    ] as const) {
      await act(async () => { fireEvent.click(screen.getByRole('radio', { name: percentile })); });
      expect(table.getByRole('columnheader', { name: `TTFT ${percentile}` })).toBeTruthy();
      expect(table.getByRole('columnheader', { name: `Worst ${tail}% speed` })).toBeTruthy();
      expect(table.getAllByRole('cell', { name: latency }).length).toBeGreaterThan(0);
      expect(table.getAllByRole('cell', { name: speed }).length).toBeGreaterThan(0);
      expect(screen.getByText(`${group}: ${metric === 'ttft' ? `TTFT ${percentile}` : `Worst ${tail}% speed`}`)).toBeTruthy();
      expect(summary()).toBe(initialSummary);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('normalizes both table columns to the active metric percentile in legacy links', () => {
    renderPage('ttft_p=p99&speed_p=p50');

    expect(screen.getByRole('columnheader', { name: 'TTFT p99' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Worst 1% speed' })).toBeTruthy();
    expect(screen.getAllByRole('cell', { name: '500ms' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('cell', { name: '12.5 tok/s' }).length).toBeGreaterThan(0);
  });

  it('sorts the table by the percentile its column names', async () => {
    const { router } = renderPage('ttft_p=p95&sort=ttft');
    const modelOrder = () => screen.getAllByRole('row').slice(1).map(row => row.querySelector('td')?.textContent);

    expect(modelOrder()).toEqual(['model-a', 'model-b']);

    await act(async () => { fireEvent.click(screen.getByRole('radio', { name: 'p99' })); });
    await waitFor(() => expect(urlSearch(router).get('p')).toBe('p99'));
    expect(modelOrder()).toEqual(['model-b', 'model-a']);
  });

  it('preserves the shared percentile across metric switches, links, refresh and reload', async () => {
    const fetch = vi.fn(async () => Response.json(overview));
    vi.stubGlobal('fetch', fetch);
    const { router, unmount } = renderPage('ttft_p=p99&speed_p=p50');

    const target = screen.getByRole('radio', { name: 'p50' }).getAttribute('href');
    expect(parsePerformanceUrlState(new URL(target!, 'http://localhost').searchParams).percentile).toBe('p50');
    await act(async () => { fireEvent.click(screen.getByRole('radio', { name: 'p50' })); });
    await waitFor(() => expect(urlSearch(router).get('p')).toBe('p50'));
    expect(urlSearch(router).has('ttft_p')).toBe(false);
    expect(urlSearch(router).has('speed_p')).toBe(false);

    await act(async () => { fireEvent.click(screen.getByRole('radio', { name: 'Output speed' })); });
    await waitFor(() => expect(urlSearch(router).get('m')).toBe('tokPerSec'));
    expect(screen.getByRole('radio', { name: 'p50' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('By Model: Worst 50% speed')).toBeTruthy();

    await act(async () => { fireEvent.click(screen.getByRole('radio', { name: 'p99' })); });
    await waitFor(() => expect(urlSearch(router).get('p')).toBe('p99'));
    expect(screen.getByRole('columnheader', { name: 'TTFT p99' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Worst 1% speed' })).toBeTruthy();
    expect(screen.getByText('By Model: Worst 1% speed')).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh performance' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh performance' }).hasAttribute('disabled')).toBe(false));
    expect(urlSearch(router).get('p')).toBe('p99');
    const address = urlSearch(router).toString();
    unmount();
    renderPage(address);
    expect(screen.getByText('By Model: Worst 1% speed')).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'TTFT p99' })).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('radio', { name: 'TTFT' })); });
    expect(screen.getByText('By Model: TTFT p99')).toBeTruthy();
  });

  it.each([
    ['ttft', 'speed', ['model-b', 'model-a'], ['model-a', 'model-b']],
    ['tokPerSec', 'ttft', ['model-a', 'model-b'], ['model-b', 'model-a']],
  ] as const)('updates the inactive metric sort with chart %s', async (metric, sort, before, after) => {
    renderPage(`m=${metric}&sort=${sort}`);
    const modelOrder = () => screen.getAllByRole('row').slice(1).map(row => row.querySelector('td')?.textContent);
    expect(modelOrder()).toEqual(before);
    await act(async () => { fireEvent.click(screen.getByRole('radio', { name: 'p99' })); });
    expect(modelOrder()).toEqual(after);
    expect(screen.getByRole('columnheader', { name: sort === 'ttft' ? 'TTFT p99' : 'Worst 1% speed' }).getAttribute('aria-sort')).toBe('descending');
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
