import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { dashboardBucketFrames } from '../../src/components/charts/dashboard-time';
import { buildPerformanceQuery, type PerformanceDataset } from '../../src/components/performance/data';
import { parsePerformanceUrlState, type PerformanceDisplayRecord, type PerformanceOverviewView } from '../../src/components/performance/overview';
import { i18n } from '../../src/i18n';
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

const overview: PerformanceOverviewView = {
  series: [record('model-a'), record('model-b')],
  summary: record(''),
  rows: [
    record('model-a', { requests: 2, ttftMsP50: 100, ttftMsP95: 400, ttftMsP99: 450, tpotUsP50: 10_000, tpotUsP95: 50_000, tpotUsP99: 60_000 }),
    record('model-b', { requests: 9, ttftMsP50: 200, ttftMsP95: 300, ttftMsP99: 500 }),
  ],
  dimensionValues: { models: ['model-a', 'model-b'], upstreams: [], operations: [], runtimeLocations: [], keyIds: [], userIds: [] },
  users: [],
  upstreams: [],
  keys: [],
};

const renderPage = (search: string, data = overview, dataset?: PerformanceDataset) => {
  const state = parsePerformanceUrlState(new URLSearchParams(search));
  const router = createMemoryRouter([{
    path: '/',
    Component: () => <DashboardMonitorPerformance
      loaderData={{
        currentUserId: '1',
        error: null,
        loadedAt,
        overview: data,
        dataset,
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

const chartTitle = (metric: { ttft: string } | { tail: number }) => i18n.t('monitoring.performance.chartTitle', {
  group: i18n.t('monitoring.performance.groupBy.model'),
  metric: 'ttft' in metric
    ? i18n.t('monitoring.performance.tables.ttft', { percentile: metric.ttft })
    : i18n.t('monitoring.performance.tables.speed', { tail: metric.tail }),
});

describe('Performance table state', () => {
  it('keeps the active tab and table until the new ranking loads in the in-progress page window', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(loadedAt + 3_600_000);
    const queries: URLSearchParams[] = [];
    let finishChart: (() => void) | undefined;
    let finishRanking: (() => void) | undefined;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const { searchParams } = new URL(String(input), 'http://localhost');
      queries.push(searchParams);
      const dimension = searchParams.get('dimension');
      if (dimension === 'model') await new Promise<void>(resolve => { finishChart = resolve; });
      if (dimension === 'upstream') await new Promise<void>(resolve => { finishRanking = resolve; });
      return Response.json({
        reset: true, start: searchParams.get('start'), end: searchParams.get('end'), cursor: searchParams.get('start'),
        edges: { ttft_ms: [], tpot_us: [] }, scope: { actorId: 1, ownedKeyIds: [], visibility: 'all' },
        metadataVisibility: { complete: true, userIds: [], upstreamIds: [] }, users: [], upstreams: [], keys: [],
        buckets: [{
          start: searchParams.get('start'), end: searchParams.get('end'), bucket: searchParams.get('start'),
          rows: [{ group: dimension === 'upstream' ? 'upstream-a' : 'model-a', requests: 1, errors: 0, ttftSamples: 0, tpotSamples: 0, neutral: 1, ttft: [], tpot: [] }],
          dimensionValues: { models: ['model-a'], upstreams: [], operations: [], runtimeLocations: [], userIds: [], keyIds: [] },
        }],
      });
    }));
    try {
      const { router } = renderPage('');
      fireEvent.click(screen.getByRole('button', { name: 'Refresh performance' }));
      await waitFor(() => expect(finishChart).toBeTypeOf('function'));
      const upstreamTab = screen.getByRole('tab', { name: i18n.t('monitoring.performance.groupBy.upstream') });
      fireEvent.click(upstreamTab);
      await waitFor(() => expect(finishRanking).toBeTypeOf('function'));
      const modelName = i18n.t('monitoring.performance.groupBy.model');
      expect(screen.getByRole('tab', { name: modelName }).getAttribute('aria-selected')).toBe('true');
      expect(within(screen.getByRole('table', { name: modelName })).getByText('model-a')).toBeTruthy();
      expect(screen.getByLabelText(i18n.t('monitoring.performance.actions.refreshBreakdown'))).toBeTruthy();
      expect(urlSearch(router).get('tab')).toBeNull();
      await act(async () => { finishRanking?.(); });
      expect(upstreamTab.getAttribute('aria-selected')).toBe('true');
      const tableName = i18n.t('monitoring.performance.groupBy.upstream');
      expect(within(await screen.findByRole('table', { name: tableName })).getByText('upstream-a')).toBeTruthy();
      expect(urlSearch(router).get('tab')).toBe('upstream');
      expect(queries[1]?.get('end')).toBe(queries[0]?.get('end'));
      await act(async () => { finishChart?.(); });
      expect(within(screen.getByRole('table', { name: tableName })).getByText('upstream-a')).toBeTruthy();
      expect(queries.map(query => query.get('dimension'))).toEqual(['model', 'upstream']);
    } finally {
      clock.mockRestore();
    }
  });

  it('keeps the active ranking after a failed switch and commits a successful retry', async () => {
    let attempts = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const { searchParams } = new URL(String(input), 'http://localhost');
      if (++attempts === 1) return Response.json({ error: 'Ranking unavailable' }, { status: 500 });
      return Response.json({
        reset: true, start: searchParams.get('start'), end: searchParams.get('end'), cursor: searchParams.get('start'),
        buckets: [], edges: { ttft_ms: [], tpot_us: [] }, scope: { actorId: 1, ownedKeyIds: [], visibility: 'all' },
        metadataVisibility: { complete: true, userIds: [], upstreamIds: [] }, users: [], upstreams: [], keys: [],
      });
    }));
    const { router } = renderPage('');
    const modelName = i18n.t('monitoring.performance.groupBy.model');
    const upstreamTab = screen.getByRole('tab', { name: i18n.t('monitoring.performance.groupBy.upstream') });
    fireEvent.click(upstreamTab);

    await screen.findByText('Ranking unavailable');
    expect(screen.getByRole('tab', { name: modelName }).getAttribute('aria-selected')).toBe('true');
    expect(within(screen.getByRole('table', { name: modelName })).getByText('model-a')).toBeTruthy();
    expect(urlSearch(router).get('tab')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: i18n.t('monitoring.performance.actions.retryBreakdown') }));
    await waitFor(() => expect(upstreamTab.getAttribute('aria-selected')).toBe('true'));
    expect(urlSearch(router).get('tab')).toBe('upstream');
    expect(screen.queryByText('Ranking unavailable')).toBeNull();
    expect(attempts).toBe(2);
  });

  it('discards the visible ranking when the same page refresh confirms a revoked scope', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(loadedAt + 3_600_000);
    const scope = (upstream: string) => ({ actorId: 1, ownedKeyIds: [], visibility: { userIds: [1], upstreamIds: [upstream] } });
    const request = buildPerformanceQuery(parsePerformanceUrlState(new URLSearchParams()), 'model', loadedAt);
    const initial: PerformanceDataset = {
      request, loadedAt,
      snapshot: {
        start: request.start, end: request.end, cursor: '2026-08-05T11', reset: true, buckets: [],
        scope: scope('upstream-a'),
        metadataVisibility: { complete: false, userIds: [1], upstreamIds: ['upstream-a'] },
        users: [], upstreams: [], keys: [],
      },
    };
    const rankings: URLSearchParams[] = [];
    let finishChart: (() => void) | undefined;
    let finishRanking: (() => void) | undefined;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const { searchParams } = new URL(String(input), 'http://localhost');
      const dimension = searchParams.get('dimension');
      const ranking = dimension === 'upstream';
      if (ranking) rankings.push(searchParams);
      if (!ranking && searchParams.has('cursor')) await new Promise<void>(resolve => { finishChart = resolve; });
      if (ranking && rankings.length === 2) await new Promise<void>(resolve => { finishRanking = resolve; });
      const upstream = ranking && rankings.length === 1 ? 'upstream-a' : 'upstream-b';
      return Response.json({
        ...initial.snapshot, reset: !searchParams.has('cursor'),
        start: searchParams.get('cursor') ?? searchParams.get('start'), end: searchParams.get('end'),
        edges: { ttft_ms: [], tpot_us: [] }, scope: scope(upstream),
        metadataVisibility: { complete: false, userIds: [1], upstreamIds: [upstream] },
        buckets: [{
          start: searchParams.get('start'), end: searchParams.get('end'), bucket: searchParams.get('start'),
          rows: [{ group: ranking ? upstream : 'model-a', requests: 1, errors: 0, ttftSamples: 0, tpotSamples: 0, neutral: 1, ttft: [], tpot: [] }],
          dimensionValues: { models: ['model-a'], upstreams: [upstream], operations: [], runtimeLocations: [], userIds: [], keyIds: [] },
        }],
      });
    }));
    try {
      renderPage('', overview, initial);
      fireEvent.click(screen.getByRole('button', { name: 'Refresh performance' }));
      await waitFor(() => expect(finishChart).toBeTypeOf('function'));
      const tableName = i18n.t('monitoring.performance.groupBy.upstream');
      fireEvent.click(screen.getByRole('tab', { name: tableName }));
      expect(within(await screen.findByRole('table', { name: tableName })).getByText('upstream-a')).toBeTruthy();
      await act(async () => { finishChart?.(); });
      expect(screen.queryByRole('table', { name: tableName })).toBeNull();
      await waitFor(() => expect(finishRanking).toBeTypeOf('function'));
      expect(rankings[1]?.get('end')).toBe(rankings[0]?.get('end'));
      expect(rankings[1]?.has('cursor')).toBe(false);
      await act(async () => { finishRanking?.(); });
      expect(within(await screen.findByRole('table', { name: tableName })).getByText('upstream-b')).toBeTruthy();
      expect(screen.queryByText('upstream-a')).toBeNull();
    } finally {
      clock.mockRestore();
    }
  });

  it.each(['ttft', 'tokPerSec'] as const)('updates both table metrics for every percentile with chart %s', async metric => {
    const data = { ...overview, rows: [record('model-a')] };
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    renderPage(`m=${metric}`, data);
    const table = within(screen.getByRole('table', { name: i18n.t('monitoring.performance.groupBy.model') }));
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
      expect(screen.getByText(chartTitle(metric === 'ttft' ? { ttft: percentile } : { tail }))).toBeTruthy();
      expect(summary()).toBe(initialSummary);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves the shared percentile across metric switches, links, refresh and reload', async () => {
    const fetch = vi.fn(async () => Response.json({
      reset: true, start: '2026-08-04T13', end: '2026-08-05T13', cursor: '2026-08-05T11',
      buckets: [], edges: { ttft_ms: [], tpot_us: [] }, scope: { actorId: 1, ownedKeyIds: [], visibility: 'all' },
      metadataVisibility: { complete: true, userIds: [], upstreamIds: [] }, users: [], upstreams: [], keys: [],
    }));
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
    expect(screen.getByText(chartTitle({ tail: 50 }))).toBeTruthy();

    await act(async () => { fireEvent.click(screen.getByRole('radio', { name: 'p99' })); });
    await waitFor(() => expect(urlSearch(router).get('p')).toBe('p99'));
    expect(screen.getByRole('columnheader', { name: 'TTFT p99' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Worst 1% speed' })).toBeTruthy();
    expect(screen.getByText(chartTitle({ tail: 1 }))).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh performance' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh performance' }).hasAttribute('disabled')).toBe(false));
    expect(urlSearch(router).get('p')).toBe('p99');
    const address = urlSearch(router).toString();
    unmount();
    renderPage(address);
    expect(screen.getByText(chartTitle({ tail: 1 }))).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'TTFT p99' })).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('radio', { name: 'TTFT' })); });
    expect(screen.getByText(chartTitle({ ttft: 'p99' }))).toBeTruthy();
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
});
