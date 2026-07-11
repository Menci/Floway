import type { LocationQuery, LocationQueryValue } from 'vue-router';

import { dashboardRangeQuery, type DashboardRange } from '../../components/charts/dashboard-chart.ts';
import type { PerformanceDisplayRecord } from '@floway-dev/gateway/control-plane/performance/aggregate';

// Pure helpers backing the performance dashboard page. Isolated from the
// .vue so they can be exercised by Vitest without mounting Vue, the auth
// store, or chart libs.

export type PerformanceView = 'all-by-user' | 'self-by-key';
export type GroupBy = 'keyId' | 'userId' | 'model' | 'upstream' | 'operation' | 'runtimeLocation';
export type MetricView = 'ttft' | 'tokPerSec';
export type PercentileKey = 'p50' | 'p95' | 'p99';
export type TableSortKey = 'group' | 'requests' | 'errors' | 'ttftMsP95' | 'tpotUsP95';
export type SortDir = 'asc' | 'desc';

// PerformanceDisplayRecord + the human label resolved once at sort time so
// the template never re-invokes resolveGroupName per render tick.
export interface DisplayRow extends PerformanceDisplayRecord {
  groupLabel: string;
}

export interface DimensionValues {
  models: string[];
  upstreams: string[];
  operations: string[];
  runtimeLocations: string[];
  keyIds: string[];
  userIds: number[];
}

export interface UserMetadata { id: number; username: string }
export interface KeyMetadata { id: string; name: string; createdAt: string }

export interface PerformanceOverviewResponse {
  series: PerformanceDisplayRecord[];
  // Backend produces one breakdown per PerformanceGroupBy axis in a single
  // record traversal. 'none' is the summary (all buckets, no group split);
  // every other key is the equivalent By-X panel row set.
  axes: Record<GroupBy | 'none', PerformanceDisplayRecord[]>;
  dimensionValues: DimensionValues;
  users: UserMetadata[];
  keys: KeyMetadata[];
}

export const emptyOverview = (): PerformanceOverviewResponse => ({
  series: [],
  axes: { none: [], model: [], upstream: [], runtimeLocation: [], operation: [], keyId: [], userId: [] },
  dimensionValues: { models: [], upstreams: [], operations: [], runtimeLocations: [], keyIds: [], userIds: [] },
  users: [], keys: [],
});

// Zero-counter, null-percentile record for the summary fallback when the
// backend returns no `none` axis row (empty selection). Kept next to the
// PerformanceDisplayRecord shape so a field rename lands here, not in a
// silently-drifting inline literal.
export const emptyDisplayRecord = (bucket: string, group: string): PerformanceDisplayRecord => ({
  bucket, group,
  requests: 0,
  errors: 0,
  ttftSamples: 0,
  tpotSamples: 0,
  neutral: 0,
  ttftMsP50: null,
  ttftMsP95: null,
  ttftMsP99: null,
  tpotUsP50: null,
  tpotUsP95: null,
  tpotUsP99: null,
});

// URL <-> state (de)serialization. Every widget's state lives in the URL query
// so refreshing / copying the URL restores the same view. Only non-default
// values are written so pristine URLs stay clean.
export const GROUP_BY_VALUES = ['model', 'upstream', 'operation', 'runtimeLocation', 'keyId', 'userId'] as const;
export const METRIC_VALUES = ['ttft', 'tokPerSec'] as const;
export const PERCENTILE_VALUES = ['p50', 'p95', 'p99'] as const;
export const RANGE_VALUES = ['today', '7d', '30d'] as const;
export const SORT_KEY_VALUES = ['group', 'requests', 'errors', 'ttftMsP95', 'tpotUsP95'] as const;
export const SORT_DIR_VALUES = ['asc', 'desc'] as const;

const asStr = (v: LocationQueryValue | LocationQueryValue[] | undefined): string =>
  (typeof v === 'string' ? v : '');
const asOneOf = <T extends string>(v: string, allowed: readonly T[], fallback: T): T =>
  (allowed as readonly string[]).includes(v) ? (v as T) : fallback;

export interface UrlState {
  metric: MetricView;
  percentile: PercentileKey;
  groupBy: GroupBy;
  range: DashboardRange;
  filterModel: string;
  filterUpstream: string;
  filterOperation: string;
  filterRuntime: string;
  filterUserId: string;
  filterKeyId: string;
  hidden: string[];
  sortKey: TableSortKey;
  sortDir: SortDir;
}

// Single source of truth for URL <-> UrlState. Every field declares its
// query key, how to parse a raw string, and how to serialize back — returning
// `undefined` from `serialize` elides the key so pristine defaults leave no
// query string behind. parseUrlState and serializeUrlState both loop over
// this map, so read and write can never drift.
interface UrlField<T> {
  urlKey: string;
  parse: (v: string) => T;
  serialize: (v: T) => string | undefined;
}

const enumField = <T extends string>(urlKey: string, allowed: readonly T[], fallback: T): UrlField<T> => ({
  urlKey,
  parse: v => asOneOf(v, allowed, fallback),
  serialize: v => (v === fallback ? undefined : v),
});

const stringField = (urlKey: string): UrlField<string> => ({
  urlKey,
  parse: v => v,
  serialize: v => (v === '' ? undefined : v),
});

const listField = (urlKey: string): UrlField<string[]> => ({
  urlKey,
  parse: v => v.split(',').map(decodeURIComponent).filter(Boolean),
  serialize: v => (v.length > 0 ? v.map(encodeURIComponent).join(',') : undefined),
});

export const URL_FIELDS = {
  metric: enumField('m', METRIC_VALUES, 'ttft'),
  percentile: enumField('pct', PERCENTILE_VALUES, 'p95'),
  groupBy: enumField('g', GROUP_BY_VALUES, 'model'),
  range: enumField('r', RANGE_VALUES, 'today'),
  filterModel: stringField('fm'),
  filterUpstream: stringField('fu'),
  filterOperation: stringField('fo'),
  filterRuntime: stringField('fr'),
  filterUserId: stringField('fusr'),
  filterKeyId: stringField('fk'),
  hidden: listField('hide'),
  sortKey: enumField('sort', SORT_KEY_VALUES, 'requests'),
  sortDir: enumField('dir', SORT_DIR_VALUES, 'desc'),
} satisfies { [K in keyof UrlState]: UrlField<UrlState[K]> };

export const parseUrlState = (q: LocationQuery): UrlState => {
  const out: Partial<Record<keyof UrlState, unknown>> = {};
  for (const key of Object.keys(URL_FIELDS) as (keyof UrlState)[]) {
    const field = URL_FIELDS[key];
    out[key] = field.parse(asStr(q[field.urlKey]));
  }
  return out as UrlState;
};

export const serializeUrlState = (state: UrlState): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const key of Object.keys(URL_FIELDS) as (keyof UrlState)[]) {
    const field = URL_FIELDS[key];
    // Union-of-serialize collapses its param type to `never` under
    // contravariance; cast state[key] so the loop compiles. Runtime call is
    // sound because the `satisfies` clause pairs each key with its own field.
    const value = field.serialize(state[key] as never);
    if (value !== undefined) out[field.urlKey] = value;
  }
  return out;
};

export const buildOverviewQuery = (state: UrlState, view: PerformanceView, at: number): Record<string, string> => {
  const { start, end, bucket } = dashboardRangeQuery(state.range, at);
  const q: Record<string, string> = {
    start, end, bucket,
    timezone_offset_minutes: String(new Date().getTimezoneOffset()),
    view,
    group_by: state.groupBy,
  };
  if (state.filterModel !== '') q.filter_model = state.filterModel;
  if (state.filterUpstream !== '') q.filter_upstream = state.filterUpstream;
  if (state.filterOperation !== '') q.filter_operation = state.filterOperation;
  if (state.filterRuntime !== '') q.filter_runtime_location = state.filterRuntime;
  if (state.filterUserId !== '') q.filter_user_id = state.filterUserId;
  if (state.filterKeyId !== '') q.filter_key_id = state.filterKeyId;
  return q;
};

export const sortRows = (
  rows: readonly PerformanceDisplayRecord[],
  key: TableSortKey,
  dir: SortDir,
  groupBy: GroupBy,
  resolveGroupName: (group: string, groupBy: GroupBy) => string,
): DisplayRow[] => {
  // Output speed shown as tok/s (higher = better) but stored as tpotUs
  // (lower = better); invert on that key so asc/desc match the header
  // semantics. Nulls always sort last regardless of direction.
  const invert = key === 'tpotUsP95' ? -1 : 1;
  const sign = (dir === 'asc' ? 1 : -1) * invert;
  // Resolve group label once per row so the group-column sort and template
  // reads don't call resolveGroupName repeatedly on every reactive tick.
  const withLabel: DisplayRow[] = rows.map(r => ({ ...r, groupLabel: resolveGroupName(r.group, groupBy) }));
  if (key === 'group') {
    return withLabel.sort((a, b) => a.groupLabel.localeCompare(b.groupLabel) * sign);
  }
  const compareNumbers = (a: number | null, b: number | null): number => {
    if (a === null && b === null) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    return (a - b) * sign;
  };
  return withLabel.sort((a, b) => compareNumbers(a[key], b[key]));
};
