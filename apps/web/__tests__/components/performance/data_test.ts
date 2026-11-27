import { afterEach, expect, it, vi } from 'vitest';

import { dashboardChartBuckets } from '../../../src/components/charts/dashboard-time';
import { OTHER_SERIES_ID } from '../../../src/components/charts/series-grouping';
import {
  buildPerformanceChartData,
  buildPerformanceQuery,
  createPerformanceLoader,
  performanceOverviewForDisplay,
  performanceRanking,
  type PerformanceDataset,
  type PerformanceQuery,
} from '../../../src/components/performance/data';
import type { PerformanceLabels } from '../../../src/components/performance/overview';
import type { PerformanceSlice, PerformanceSlicesResponse } from '@floway-dev/gateway/browser';
import { percentileFromBuckets } from '@floway-dev/protocols/browser';

afterEach(() => vi.unstubAllGlobals());

const query: PerformanceQuery = {
  range: 'today', groupBy: 'model',
  filters: { model: [], upstream: [], operation: [], runtimeLocation: [], userId: [], keyId: [] },
};

const slice = (hour: string, end: string, count: number): PerformanceSlice => ({
  start: hour, end, bucket: hour,
  rows: [{ group: 'model-a', requests: count, errors: 0, ttftSamples: count, tpotSamples: 0, neutral: 0, ttft: [[0, count]], tpot: [] }],
  dimensionValues: { models: ['model-a'], upstreams: [], operations: [], runtimeLocations: [], userIds: [], keyIds: [] },
});

const first: PerformanceSlicesResponse = {
  start: '2026-11-25T13', end: '2026-11-26T13', cursor: '2026-11-26T11', reset: true,
  buckets: [
    slice('2026-11-26T10', '2026-11-26T11', 1),
    slice('2026-11-26T11', '2026-11-26T12', 2),
  ],
  edges: { ttft_ms: [[0, 100]], tpot_us: [] },
  scope: { actorId: 1, ownedKeyIds: [], visibility: 'all' },
  metadataVisibility: { complete: true, userIds: [], upstreamIds: [] },
  keys: [], users: [], upstreams: [],
};
const now = Date.UTC(2026, 10, 26, 12);

it('replaces overlapping hours and decodes each delta against its own histogram edges', async () => {
  const parameters: URLSearchParams[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const request = new URL(String(input), 'http://localhost').searchParams;
    parameters.push(request);
    if (!request.has('cursor')) return Response.json(first);
    return Response.json({
      ...first, start: '2026-11-26T11', reset: false,
      buckets: [slice('2026-11-26T11', '2026-11-26T12', 5)], edges: { ttft_ms: [[100, 200]], tpot_us: [] },
    } satisfies PerformanceSlicesResponse);
  }));
  const loader = createPerformanceLoader();
  const [initial] = await Promise.all([loader.load(query, 'model', now), loader.load(query, 'model', now)]);
  const baseline = initial.data!;
  expect(performanceOverviewForDisplay(baseline).rows[0]).toMatchObject({ requests: 3, ttftMsP95: 75 });
  const current = (await loader.load(query, 'model', now + 60_000)).data!;
  expect(parameters.map(request => request.get('cursor'))).toEqual([null, '2026-11-26T11']);
  const view = performanceOverviewForDisplay(current);
  expect(view.series.map(row => row.requests)).toEqual([1, 5]);
  expect(view.rows[0]).toMatchObject({ requests: 6, ttftMsP95: 100 + 100 * 5 / 6 });
});

it.each([false, true])('keeps the new ranking scope when a superseded request resolves later (cached: %s)', async cached => {
  const narrowed = { ...first, scope: { actorId: 1, ownedKeyIds: [], visibility: { userIds: [1], upstreamIds: [] } } };
  let release: (() => void) | undefined;
  const fetch = vi.fn(async () => {
    if (release !== undefined) return Response.json(narrowed);
    await new Promise<void>(resolve => { release = resolve; });
    return Response.json(first);
  });
  vi.stubGlobal('fetch', fetch);
  const { edges: _edges, ...fields } = narrowed;
  const dataset: PerformanceDataset = {
    request: buildPerformanceQuery(query, 'upstream', now), loadedAt: now,
    snapshot: { ...fields, buckets: [] },
  };
  const loader = createPerformanceLoader(cached ? dataset : undefined);
  const superseded = loader.load(query, 'upstream', now, JSON.stringify(first.scope));
  const scopeKey = JSON.stringify(narrowed.scope);
  const current = (await loader.load(query, 'upstream', now, scopeKey)).data;
  release?.();
  await superseded;
  expect(fetch).toHaveBeenCalledTimes(cached ? 1 : 2);
  expect(loader.get(query, 'upstream', now, scopeKey)).toBe(current);
  expect(loader.get(query, 'upstream', now, JSON.stringify(first.scope))).toBeUndefined();
});

it('rejects a ranking total that overflows only after merging safe slice counts', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({
    ...first,
    buckets: [
      slice('2026-11-26T10', '2026-11-26T11', Number.MAX_SAFE_INTEGER),
      slice('2026-11-26T11', '2026-11-26T12', 1),
    ],
  } satisfies PerformanceSlicesResponse)));
  const dataset = (await createPerformanceLoader().load(query, 'model', now)).data!;
  expect(() => performanceRanking(dataset)).toThrow(RangeError);
});

it('aggregates raw histograms for visible Other members before percentile evaluation', async () => {
  const hour = '2026-11-26T10';
  const response: PerformanceSlicesResponse = {
    ...first,
    edges: { ttft_ms: [[0, 100], [100, 200], [200, 300]], tpot_us: [[10_000, 20_000]] },
    buckets: [{
      start: hour,
      end: '2026-11-26T11',
      bucket: hour,
      rows: [
        { group: 'primary', requests: 2000, errors: 0, ttftSamples: 2000, tpotSamples: 2000, neutral: 0, ttft: [[0, 2000]], tpot: [[0, 2000]] },
        { group: 'minor-a', requests: 5, errors: 0, ttftSamples: 5, tpotSamples: 5, neutral: 0, ttft: [[1, 5]], tpot: [[0, 5]] },
        { group: 'minor-b', requests: 5, errors: 0, ttftSamples: 5, tpotSamples: 5, neutral: 0, ttft: [[2, 5]], tpot: [[0, 5]] },
      ],
      dimensionValues: {
        models: ['primary', 'minor-a', 'minor-b'],
        upstreams: [],
        operations: [],
        runtimeLocations: [],
        userIds: [],
        keyIds: [],
      },
    }],
  };
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(response)));
  const dataset = (await createPerformanceLoader().load(query, 'model', now)).data!;
  const labels: PerformanceLabels = { upstreams: new Map(), upstreamHues: new Map(), users: new Map(), keys: new Map() };
  const buckets = dashboardChartBuckets('today', now);

  const expectedOtherP50 = percentileFromBuckets([{ lower: 200, upper: 300, count: 5 }], 0.5);
  const chartData = buildPerformanceChartData({
    dataset,
    buckets,
    groupBy: 'model',
    metric: 'ttft',
    foldSmallSeries: true,
    hidden: new Set(['minor-a']),
    labels,
    otherLabel: 'Other',
  });
  expect(chartData.other?.members.map(member => member.id)).toEqual(['minor-a', 'minor-b']);
  expect(chartData.series.find(row => row.group === OTHER_SERIES_ID)?.ttftMsP50).toBe(expectedOtherP50);
});
