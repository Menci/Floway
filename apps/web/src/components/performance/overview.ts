import { oneOf } from '../../lib/search-params';
import { dashboardRangeQuery, type DashboardRange } from '../charts/dashboard-time';

export type PerformanceView = 'all-by-user' | 'self-by-key';
export type PerformanceRange = DashboardRange;
export type PerformanceGroupBy = 'keyId' | 'userId' | 'model' | 'upstream' | 'operation' | 'runtimeLocation';
export type PerformanceMetric = 'ttft' | 'tokPerSec';
export type PerformancePercentile = 'p50' | 'p95' | 'p99';

export interface PerformanceDisplayRecord {
  bucket: string;
  group: string;
  requests: number;
  errors: number;
  ttftSamples: number;
  tpotSamples: number;
  neutral: number;
  ttftMsP50: number | null;
  ttftMsP95: number | null;
  ttftMsP99: number | null;
  tpotUsP50: number | null;
  tpotUsP95: number | null;
  tpotUsP99: number | null;
}

export interface PerformanceFilters {
  model: string[];
  upstream: string[];
  operation: string[];
  runtimeLocation: string[];
  userId: string[];
  keyId: string[];
}

export interface PerformanceUrlState {
  metric: PerformanceMetric;
  percentile: PerformancePercentile;
  groupBy: PerformanceGroupBy;
  range: PerformanceRange;
  filters: PerformanceFilters;
  hidden: string[];
}

export interface PerformanceOverviewResponse {
  series: PerformanceDisplayRecord[];
  axes: Record<PerformanceGroupBy | 'none', PerformanceDisplayRecord[]>;
  dimensionValues: {
    models: string[];
    upstreams: string[];
    operations: string[];
    runtimeLocations: string[];
    keyIds: string[];
    userIds: number[];
  };
  users: Array<{ id: number; username: string }>;
  keys: Array<{ id: string; name: string; createdAt: string }>;
}

// The Hono client appends one occurrence per array entry and nothing at all for
// an empty array, so an unset filter leaves the query string untouched.
export const buildPerformanceQuery = (
  range: PerformanceRange,
  groupBy: PerformanceGroupBy,
  filters: PerformanceFilters,
  nowMs: number,
): Record<string, string | string[]> => ({
  ...dashboardRangeQuery(range, nowMs),
  group_by: groupBy,
  timezone_offset_minutes: String(new Date(nowMs).getTimezoneOffset()),
  filter_model: filters.model,
  filter_upstream: filters.upstream,
  filter_operation: filters.operation,
  filter_runtime_location: filters.runtimeLocation,
  filter_user_id: filters.userId,
  filter_key_id: filters.keyId,
});

export const performanceValue = (
  record: PerformanceDisplayRecord,
  metric: PerformanceMetric,
  percentile: PerformancePercentile,
): number | null => {
  if (metric === 'ttft') {
    return percentile === 'p50' ? record.ttftMsP50 : percentile === 'p95' ? record.ttftMsP95 : record.ttftMsP99;
  }
  const us = percentile === 'p50' ? record.tpotUsP50 : percentile === 'p95' ? record.tpotUsP95 : record.tpotUsP99;
  return us === null || us <= 0 ? null : 1_000_000 / us;
};

// Indexed rather than scanned per call: a group is resolved to a name once per
// chart series, once per table row and twice per sort comparison.
export interface PerformanceLabels {
  upstreams: ReadonlyMap<string, string>;
  users: ReadonlyMap<string, string>;
  keys: ReadonlyMap<string, string>;
}

export const performanceLabels = (
  overview: PerformanceOverviewResponse,
  upstreamNames: ReadonlyMap<string, string>,
): PerformanceLabels => ({
  upstreams: upstreamNames,
  users: new Map(overview.users.map(user => [String(user.id), user.username])),
  keys: new Map(overview.keys.map(key => [key.id, key.name])),
});

export const resolvePerformanceGroup = (
  group: string,
  groupBy: PerformanceGroupBy,
  labels: PerformanceLabels,
): string => {
  if (groupBy === 'upstream') return labels.upstreams.get(group) ?? group;
  if (groupBy === 'userId') return labels.users.get(group) ?? `user ${group}`;
  if (groupBy === 'keyId') return labels.keys.get(group) ?? group;
  return group;
};

const hiddenSeriesFormatVersion = '2';

const parseHiddenSeries = (search: URLSearchParams): string[] => search.get('hidev') === hiddenSeriesFormatVersion
  ? search.getAll('hide')
  : (search.get('hide') ?? '').split(',').map(decodeURIComponent).filter(Boolean);

const filterValuesFromUrl = (search: URLSearchParams, key: string): string[] =>
  [...new Set(search.getAll(key).filter(Boolean))];

export const parsePerformanceUrlState = (search: URLSearchParams): PerformanceUrlState => ({
  metric: oneOf(search.get('m'), ['ttft', 'tokPerSec'], 'ttft'),
  percentile: oneOf(search.get('pct'), ['p50', 'p95', 'p99'], 'p95'),
  groupBy: oneOf(search.get('g'), ['model', 'upstream', 'operation', 'runtimeLocation', 'keyId', 'userId'], 'model'),
  range: oneOf(search.get('r'), ['today', '7d', '30d'], 'today'),
  filters: {
    model: filterValuesFromUrl(search, 'fm'), upstream: filterValuesFromUrl(search, 'fu'), operation: filterValuesFromUrl(search, 'fo'),
    runtimeLocation: filterValuesFromUrl(search, 'fr'), userId: filterValuesFromUrl(search, 'fusr'), keyId: filterValuesFromUrl(search, 'fk'),
  },
  hidden: parseHiddenSeries(search),
});

export const serializePerformanceUrlState = (state: PerformanceUrlState): URLSearchParams => {
  const search = new URLSearchParams();
  if (state.metric !== 'ttft') search.set('m', state.metric);
  if (state.percentile !== 'p95') search.set('pct', state.percentile);
  if (state.groupBy !== 'model') search.set('g', state.groupBy);
  if (state.range !== 'today') search.set('r', state.range);
  const filters: Array<[string, readonly string[]]> = [['fm', state.filters.model], ['fu', state.filters.upstream], ['fo', state.filters.operation], ['fr', state.filters.runtimeLocation], ['fusr', state.filters.userId], ['fk', state.filters.keyId]];
  for (const [key, values] of filters) for (const value of values) search.append(key, value);
  if (state.hidden.length) {
    search.set('hidev', hiddenSeriesFormatVersion);
    for (const id of [...state.hidden].sort()) search.append('hide', id);
  }
  return search;
};

export const clearGroupedFilter = (filters: PerformanceFilters, groupBy: PerformanceGroupBy): PerformanceFilters => ({
  ...filters,
  ...(groupBy === 'model' ? { model: [] } : {}),
  ...(groupBy === 'upstream' ? { upstream: [] } : {}),
  ...(groupBy === 'operation' ? { operation: [] } : {}),
  ...(groupBy === 'runtimeLocation' ? { runtimeLocation: [] } : {}),
  ...(groupBy === 'userId' || groupBy === 'keyId' ? { userId: [], keyId: [] } : {}),
});
