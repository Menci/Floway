import type { PerformanceDisplayRecord, PerformanceFilters, PerformanceGroupBy, PerformanceOverviewView, PerformanceRange } from './overview';
import { api, callApi, type ApiResult } from '../../api/client';
import { dashboardFixedRangeQuery } from '../charts/dashboard-time';
import type { PerformanceSlice, PerformanceSliceRow, PerformanceSlicesResponse } from '@floway-dev/gateway/browser';
import { parseTelemetryHour, percentileFromBuckets, TELEMETRY_HOUR_MS, telemetryBucketHours, type HistogramBucket } from '@floway-dev/protocols/browser';

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
  && previous.snapshot.start <= request.start && previous.snapshot.end <= request.end
  && (parseTelemetryHour(request.start) - parseTelemetryHour(previous.request.start)) % (telemetryBucketHours(request.bucket) * TELEMETRY_HOUR_MS) === 0
  && !previous.snapshot.buckets.some(bucket => bucket.start < request.start && request.start < bucket.end);

const mergeMetadata = <T>(previous: readonly T[], next: readonly T[], key: (value: T) => string | number): T[] =>
  [...new Map([...previous, ...next].map(value => [key(value), value])).values()];

const merge = (previous: Snapshot | undefined, response: Snapshot, start: string): Snapshot => {
  if (response.reset) return response;
  if (previous === undefined) throw new Error('Performance delta requires a baseline');
  if (previous.buckets.some(bucket => bucket.start < response.start && response.start < bucket.end)) {
    throw new Error('Performance delta crosses a retained bucket');
  }
  return {
    ...response, start,
    buckets: [...previous.buckets.filter(bucket => bucket.start >= start && bucket.end <= response.start), ...response.buckets],
    users: response.metadataVisibility.complete ? response.users : mergeMetadata(previous.users, response.users, user => user.id),
    upstreams: response.metadataVisibility.complete ? response.upstreams : mergeMetadata(previous.upstreams, response.upstreams, upstream => upstream.id),
  };
};

const fetchDataset = async (request: WindowQuery, now: number, previous?: PerformanceDataset): Promise<ApiResult<PerformanceDataset>> => {
  const query = previous === undefined ? request : { ...request, cursor: previous.snapshot.cursor };
  const result = await callApi(() => api.api.performance.overview.$get({ query }));
  if (result.error) return result;
  if (!('edges' in result.data)) throw new Error('Expected Performance histogram slices');
  if (previous !== undefined && !result.data.reset && JSON.stringify(result.data.scope) !== JSON.stringify(previous.snapshot.scope)) {
    return await fetchDataset(request, now);
  }
  return { data: { request, snapshot: merge(previous?.snapshot, decode(result.data), request.start), loadedAt: now } };
};

export const createPerformanceLoader = (initial?: PerformanceDataset) => {
  const cached = new Map<PerformanceGroupBy, PerformanceDataset>();
  const pending = new Map<PerformanceGroupBy, { key: string; promise: Promise<ApiResult<PerformanceDataset>> }>();
  if (initial !== undefined) cached.set(initial.request.dimension, initial);
  return {
    load(query: PerformanceQuery, dimension: PerformanceGroupBy, now: number): Promise<ApiResult<PerformanceDataset>> {
      const request = buildPerformanceQuery(query, dimension, now);
      const previous = cached.get(dimension);
      const key = JSON.stringify([queryKey(request), request.start, request.end]);
      const flight = pending.get(dimension);
      if (flight?.key === key) return flight.promise;
      if (previous !== undefined && previous.loadedAt >= now && JSON.stringify(previous.request) === JSON.stringify(request)) {
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
    get(query: PerformanceQuery, dimension: PerformanceGroupBy, now: number): PerformanceDataset | undefined {
      const previous = cached.get(dimension);
      const request = buildPerformanceQuery(query, dimension, now);
      return reusable(previous, request) ? previous : undefined;
    },
  };
};

const addHistogram = (accumulator: HistogramBucket[], delta: readonly HistogramBucket[]): void => {
  for (const bucket of delta) {
    const existing = accumulator.find(value => value.lower === bucket.lower);
    if (existing === undefined) accumulator.push({ ...bucket });
    else {
      if (existing.upper !== bucket.upper) throw new Error('Performance slices disagree on histogram bounds');
      existing.count += bucket.count;
    }
  }
};

const sum = (buckets: readonly DecodedSlice[], mode: 'series' | 'rows' | 'total'): PerformanceDisplayRecord[] => {
  const sums = new Map<string, DecodedRow & { bucket: string }>();
  for (const slice of buckets) for (const row of mode === 'total' ? (slice.total === undefined ? [] : [slice.total]) : slice.rows) {
    const bucket = mode === 'series' ? slice.bucket : 'all';
    const key = JSON.stringify([bucket, row.group]);
    let target = sums.get(key);
    if (target === undefined) {
      target = { bucket, group: row.group, requests: 0, errors: 0, ttftSamples: 0, tpotSamples: 0, neutral: 0, ttft: [], tpot: [] };
      sums.set(key, target);
    }
    target.requests += row.requests;
    target.errors += row.errors;
    target.ttftSamples += row.ttftSamples;
    target.tpotSamples += row.tpotSamples;
    target.neutral += row.neutral;
    addHistogram(target.ttft, row.ttft);
    addHistogram(target.tpot, row.tpot);
  }
  return [...sums.values()].map(({ ttft, tpot, ...counters }) => ({
    ...counters,
    ttftMsP50: percentileFromBuckets(ttft, 0.5), ttftMsP95: percentileFromBuckets(ttft, 0.95), ttftMsP99: percentileFromBuckets(ttft, 0.99),
    tpotUsP50: percentileFromBuckets(tpot, 0.5), tpotUsP95: percentileFromBuckets(tpot, 0.95), tpotUsP99: percentileFromBuckets(tpot, 0.99),
  })).sort((a, b) => a.bucket.localeCompare(b.bucket) || a.group.localeCompare(b.group));
};

export const performanceRanking = ({ snapshot }: PerformanceDataset): PerformanceDisplayRecord[] => sum(snapshot.buckets, 'rows');

export const performanceOverviewForDisplay = ({ snapshot }: PerformanceDataset): PerformanceOverviewView => {
  const { buckets, globalSummary } = snapshot;
  const collect = (key: keyof PerformanceOverviewView['dimensionValues']) =>
    [...new Set(buckets.flatMap(bucket => bucket.dimensionValues[key] as (string | number)[]))].sort();
  const dimensionValues = {
    models: collect('models') as string[], upstreams: collect('upstreams') as string[],
    operations: collect('operations') as string[], runtimeLocations: collect('runtimeLocations') as string[],
    keyIds: collect('keyIds') as string[], userIds: (collect('userIds') as number[]).sort((a, b) => a - b),
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
