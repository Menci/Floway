import {
  resolvePerformanceGroup,
  type PerformanceDisplayRecord,
  type PerformanceFilters,
  type PerformanceGroupBy,
  type PerformanceLabels,
  type PerformanceMetric,
  type PerformanceOverviewView,
  type PerformanceRange,
} from './overview';
import { api, callApi, type ApiResult } from '../../api/client';
import { dashboardFixedRangeQuery, type ChartBucket } from '../charts/dashboard-time';
import { OTHER_SERIES_COLOR } from '../charts/palette';
import { OTHER_SERIES_ID, otherSeriesGroup, partitionSeriesForOther, stableSeriesHues, type ChartSectionOther } from '../charts/series-grouping';
import type { SeriesLegendEntry } from '../charts/series-legends';
import { canContinueTelemetrySnapshot, mergeTelemetrySnapshot, sameTelemetryBucketGrid, sameTelemetryScope } from '../telemetry/snapshot';
import type { PerformanceSlice, PerformanceSliceRow, PerformanceSlicesResponse } from '@floway-dev/gateway/browser';
import { percentileFromBuckets, type HistogramBucket } from '@floway-dev/protocols/browser';

export type PerformanceQuery = { range: PerformanceRange; groupBy: PerformanceGroupBy; filters: PerformanceFilters };

export const buildPerformanceQuery = (query: PerformanceQuery, dimension: PerformanceGroupBy, now: number) => ({
  ...dashboardFixedRangeQuery(query.range, now),
  format: 'buckets' as const, group_by: query.groupBy, dimension,
  filter_model: query.filters.model, filter_upstream: query.filters.upstream, filter_operation: query.filters.operation,
  filter_runtime_location: query.filters.runtimeLocation, filter_user_id: query.filters.userId, filter_key_id: query.filters.keyId,
});
type WindowQuery = ReturnType<typeof buildPerformanceQuery>;

type Counters = Omit<PerformanceSliceRow, 'ttft' | 'tpot'>;
type DecodedRow = Counters & { ttft: HistogramBucket[]; tpot: HistogramBucket[] };
type DecodedSlice = Omit<PerformanceSlice, 'rows' | 'total'> & { rows: DecodedRow[]; total?: DecodedRow };
type Snapshot = Omit<PerformanceSlicesResponse, 'edges' | 'buckets'> & { buckets: DecodedSlice[] };
export type PerformanceDataset = { request: WindowQuery; snapshot: Snapshot; loadedAt: number };

const decode = ({ edges, buckets, ...rest }: PerformanceSlicesResponse): Snapshot => {
  const counts = (cells: PerformanceSliceRow['ttft'], bounds: PerformanceSlicesResponse['edges']['ttft_ms']): HistogramBucket[] =>
    cells.map(([index, count]) => {
      const [lower, upper] = bounds[index]!;
      return { lower, upper, count };
    });
  const decodeRow = ({ ttft, tpot, ...values }: PerformanceSliceRow): DecodedRow => ({
    ...values, ttft: counts(ttft, edges.ttft_ms), tpot: counts(tpot, edges.tpot_us),
  });
  return {
    ...rest,
    buckets: buckets.map(({ rows, total, ...fields }) => ({
      ...fields, rows: rows.map(decodeRow), ...(total === undefined ? {} : { total: decodeRow(total) }),
    })),
  };
};

const queryKey = ({ start: _start, end: _end, ...query }: WindowQuery): string =>
  JSON.stringify(Object.fromEntries(Object.entries(query).map(([field, value]) => [
    field, Array.isArray(value) ? [...new Set(value)].sort() : value,
  ])));

const reusable = (previous: PerformanceDataset | undefined, request: WindowQuery): previous is PerformanceDataset =>
  previous !== undefined && queryKey(previous.request) === queryKey(request)
  && sameTelemetryBucketGrid(previous.request, request)
  && canContinueTelemetrySnapshot(previous.snapshot, request);

const fetchDataset = async (request: WindowQuery, now: number, previous?: PerformanceDataset): Promise<ApiResult<PerformanceDataset>> => {
  const query = previous === undefined ? request : { ...request, cursor: previous.snapshot.cursor };
  const result = await callApi(() => api.api.performance.overview.$get({ query }));
  if (result.error) return result;
  if (!('edges' in result.data)) throw new Error('Expected Performance histogram slices');
  if (previous !== undefined && !result.data.reset && !sameTelemetryScope(result.data.scope, previous.snapshot.scope)) {
    return await fetchDataset(request, now);
  }
  return { data: { request, snapshot: mergeTelemetrySnapshot(previous?.snapshot, decode(result.data), request.start), loadedAt: now } };
};

export const createPerformanceLoader = (initial?: PerformanceDataset) => {
  const cached = new Map<PerformanceGroupBy, PerformanceDataset>();
  const pending = new Map<PerformanceGroupBy, { key: string; promise: Promise<ApiResult<PerformanceDataset>> }>();
  if (initial !== undefined) cached.set(initial.request.dimension, initial);
  const cachedFor = (dimension: PerformanceGroupBy, scopeKey: string | undefined) => {
    const dataset = cached.get(dimension);
    return scopeKey === undefined || (dataset !== undefined && JSON.stringify(dataset.snapshot.scope) === scopeKey)
      ? dataset : undefined;
  };
  return {
    load(query: PerformanceQuery, dimension: PerformanceGroupBy, now: number, scopeKey?: string): Promise<ApiResult<PerformanceDataset>> {
      const request = buildPerformanceQuery(query, dimension, now);
      const previous = cachedFor(dimension, scopeKey);
      const key = JSON.stringify([queryKey(request), request.start, request.end, scopeKey]);
      const flight = pending.get(dimension);
      if (flight?.key === key) return flight.promise;
      if (previous !== undefined && previous.loadedAt >= now && JSON.stringify(previous.request) === JSON.stringify(request)) {
        pending.delete(dimension);
        return Promise.resolve({ data: previous });
      }
      const promise = fetchDataset(request, now, reusable(previous, request) ? previous : undefined)
        .then(result => {
          if (result.data !== undefined && pending.get(dimension)?.promise === promise) cached.set(dimension, result.data);
          return result;
        })
        .finally(() => {
          if (pending.get(dimension)?.promise === promise) pending.delete(dimension);
        });
      pending.set(dimension, { key, promise });
      return promise;
    },
    get(query: PerformanceQuery, dimension: PerformanceGroupBy, now: number, scopeKey?: string): PerformanceDataset | undefined {
      const previous = cachedFor(dimension, scopeKey);
      const request = buildPerformanceQuery(query, dimension, now);
      return reusable(previous, request) ? previous : undefined;
    },
  };
};

const addCount = (previous: number, delta: number): number => {
  const count = previous + delta;
  if (!Number.isSafeInteger(count)) throw new RangeError('Performance count exceeds the safe integer range');
  return count;
};

const addHistogram = (accumulator: HistogramBucket[], delta: readonly HistogramBucket[]): void => {
  for (const bucket of delta) {
    const existing = accumulator.find(value => value.lower === bucket.lower);
    if (existing === undefined) accumulator.push({ ...bucket });
    else {
      if (existing.upper !== bucket.upper) throw new Error('Performance slices disagree on histogram bounds');
      existing.count = addCount(existing.count, bucket.count);
    }
  }
};

const sumDecodedRows = (items: Iterable<{ bucket: string; row: DecodedRow }>): PerformanceDisplayRecord[] => {
  const sums = new Map<string, DecodedRow & { bucket: string }>();
  for (const { bucket, row } of items) {
    const key = JSON.stringify([bucket, row.group]);
    let target = sums.get(key);
    if (target === undefined) {
      target = { bucket, group: row.group, requests: 0, errors: 0, ttftSamples: 0, tpotSamples: 0, neutral: 0, ttft: [], tpot: [] };
      sums.set(key, target);
    }
    target.requests = addCount(target.requests, row.requests);
    target.errors = addCount(target.errors, row.errors);
    target.ttftSamples = addCount(target.ttftSamples, row.ttftSamples);
    target.tpotSamples = addCount(target.tpotSamples, row.tpotSamples);
    target.neutral = addCount(target.neutral, row.neutral);
    addHistogram(target.ttft, row.ttft);
    addHistogram(target.tpot, row.tpot);
  }
  return [...sums.values()].map(({ ttft, tpot, ...counters }) => ({
    ...counters,
    ttftMsP50: percentileFromBuckets(ttft, 0.5), ttftMsP95: percentileFromBuckets(ttft, 0.95), ttftMsP99: percentileFromBuckets(ttft, 0.99),
    tpotUsP50: percentileFromBuckets(tpot, 0.5), tpotUsP95: percentileFromBuckets(tpot, 0.95), tpotUsP99: percentileFromBuckets(tpot, 0.99),
  })).sort((a, b) => a.bucket.localeCompare(b.bucket) || a.group.localeCompare(b.group));
};

const sum = (buckets: readonly DecodedSlice[], mode: 'series' | 'rows' | 'total'): PerformanceDisplayRecord[] => {
  const items: Array<{ bucket: string; row: DecodedRow }> = [];
  for (const slice of buckets) {
    const bucket = mode === 'series' ? slice.bucket : 'all';
    const rows = mode === 'total' ? (slice.total === undefined ? [] : [slice.total]) : slice.rows;
    for (const row of rows) items.push({ bucket, row });
  }
  return sumDecodedRows(items);
};

export const performanceRanking = ({ snapshot }: PerformanceDataset): PerformanceDisplayRecord[] => sum(snapshot.buckets, 'rows');

export interface PerformanceChartData {
  series: PerformanceDisplayRecord[];
  seriesByGroup: Map<string, SeriesLegendEntry>;
  other: ChartSectionOther | undefined;
}

export const buildPerformanceChartData = ({
  dataset,
  buckets,
  groupBy,
  metric,
  foldSmallSeries,
  hidden,
  labels,
  otherLabel,
}: {
  dataset: PerformanceDataset;
  buckets: readonly ChartBucket[];
  groupBy: PerformanceGroupBy;
  metric: PerformanceMetric;
  foldSmallSeries: boolean;
  hidden: ReadonlySet<string>;
  labels: PerformanceLabels;
  otherLabel: string;
}): PerformanceChartData => {
  const bucketKeys = new Set(buckets.map(bucket => bucket.key));
  const windowSlices = dataset.snapshot.buckets.filter(slice => bucketKeys.has(slice.bucket));

  const windowItems: Array<{ bucket: string; row: DecodedRow }> = [];
  const baselineRequests = new Map<string, number>();
  const activeSamples = new Map<string, number>();
  for (const slice of windowSlices) {
    for (const row of slice.rows) {
      windowItems.push({ bucket: slice.bucket, row });
      baselineRequests.set(row.group, addCount(baselineRequests.get(row.group) ?? 0, row.requests));
      const samples = metric === 'ttft' ? row.ttftSamples : row.tpotSamples;
      activeSamples.set(row.group, addCount(activeSamples.get(row.group) ?? 0, samples));
    }
  }

  const presentItems = [...baselineRequests.keys()].sort().map(id => ({
    id,
    label: resolvePerformanceGroup(id, groupBy, labels),
  }));

  const explicitHues = groupBy === 'upstream' ? labels.upstreamHues : undefined;
  const hueByGroup = stableSeriesHues(presentItems.map(item => item.id), baselineRequests, explicitHues);
  const { top, other: otherItems } = partitionSeriesForOther(presentItems, activeSamples, foldSmallSeries);
  const otherIdSet = new Set(otherItems.map(item => item.id));

  const plotItems: Array<{ bucket: string; row: DecodedRow }> = [];
  for (const entry of windowItems) {
    if (otherIdSet.has(entry.row.group)) {
      if (!hidden.has(entry.row.group)) {
        plotItems.push({ bucket: entry.bucket, row: { ...entry.row, group: OTHER_SERIES_ID } });
      }
    } else {
      plotItems.push(entry);
    }
  }

  const series = sumDecodedRows(plotItems);
  const seriesByGroup = new Map<string, SeriesLegendEntry>(top.map(item => [item.id, {
    id: item.id,
    label: item.label,
    hue: hueByGroup.get(item.id)!,
  }]));
  if (otherItems.length > 0) {
    seriesByGroup.set(OTHER_SERIES_ID, {
      id: OTHER_SERIES_ID,
      label: otherLabel,
      hue: 0,
      color: OTHER_SERIES_COLOR,
    });
  }

  return { series, seriesByGroup, other: otherSeriesGroup(otherItems) };
};

export const performanceOverviewForDisplay = ({ snapshot }: PerformanceDataset): PerformanceOverviewView => {
  const { buckets, globalSummary } = snapshot;
  const collect = <T>(values: (facets: PerformanceSlice['dimensionValues']) => T[], compare?: (a: T, b: T) => number) =>
    [...new Set(buckets.flatMap(bucket => values(bucket.dimensionValues)))].sort(compare);
  const dimensionValues = {
    models: collect(values => values.models), upstreams: collect(values => values.upstreams),
    operations: collect(values => values.operations), runtimeLocations: collect(values => values.runtimeLocations),
    keyIds: collect(values => values.keyIds), userIds: collect(values => values.userIds, (a, b) => a - b),
  };
  const userIds = new Set([...snapshot.metadataVisibility.userIds, ...dimensionValues.userIds]);
  const upstreamIds = new Set([...snapshot.metadataVisibility.upstreamIds, ...dimensionValues.upstreams]);
  return {
    series: sum(buckets, 'series'),
    rows: sum(buckets, 'rows'),
    summary: globalSummary === undefined ? sum(buckets, 'total')[0] ?? null : globalSummary,
    dimensionValues,
    users: snapshot.users.filter(row => userIds.has(row.id)),
    upstreams: snapshot.upstreams.filter(row => upstreamIds.has(row.id)),
    keys: snapshot.keys,
  };
};
