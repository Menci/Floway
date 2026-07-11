// GET /api/performance/overview — dashboard aggregate: chart series, summary,
// six per-dimension breakdown tables, and dropdown menus, all built from a
// single raw record query.
//
// View semantics mirror /api/token-usage and /api/search-usage:
// - `self-by-key` scopes rows to the actor's keys (active + soft-deleted).
//   `group_by=userId` is rejected — every row already belongs to the actor.
// - `all-by-user` aggregates across every row (callers must have
//   `canViewGlobalTelemetry`). `group_by=keyId` is rejected so we never leak
//   another user's key id into a global response.

import { aggregatePerformanceForDisplay, type PerformanceBucketGranularity, type PerformanceGroupBy } from './aggregate.ts';
import { type CtxWithQuery } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import type { PerformanceTelemetryRecord } from '../../repo/types.ts';
import type { performanceQuery } from '../schemas.ts';
import { loadTelemetryKeys, resolveTelemetryView, type ResolvedTelemetryView } from '../telemetry-view.ts';

type Ctx = CtxWithQuery<typeof performanceQuery>;

interface PerformanceFilters {
  model: string | undefined;
  upstream: string | undefined;
  operation: string | undefined;
  runtimeLocation: string | undefined;
  userId: number | undefined;
  keyId: string | undefined;
}

interface PerformanceQueryParams {
  keyId: string | undefined;
  start: string;
  end: string;
  bucket: PerformanceBucketGranularity;
  groupBy: PerformanceGroupBy;
  timezoneOffsetMinutes: number;
  filters: PerformanceFilters;
}

const readPerformanceQuery = (
  c: Ctx,
): { type: 'ok'; value: PerformanceQueryParams } | { type: 'error'; error: string } => {
  const query = c.req.valid('query');
  if (!query.start || !query.end) {
    return { type: 'error', error: 'start and end query parameters are required (e.g. 2026-03-09T00)' };
  }

  const timezoneOffsetMinutes = Number(query.timezone_offset_minutes ?? '0');
  if (!Number.isFinite(timezoneOffsetMinutes) || timezoneOffsetMinutes < -1440 || timezoneOffsetMinutes > 1440) {
    return { type: 'error', error: 'timezone_offset_minutes must be between -1440 and 1440' };
  }

  const blank = (v: string | undefined): string | undefined => (v === undefined || v === '' ? undefined : v);

  return {
    type: 'ok',
    value: {
      keyId: blank(query.key_id),
      start: query.start,
      end: query.end,
      bucket: query.bucket ?? 'hour',
      groupBy: query.group_by ?? 'model',
      timezoneOffsetMinutes,
      filters: {
        model: blank(query.filter_model),
        upstream: blank(query.filter_upstream),
        operation: blank(query.filter_operation),
        runtimeLocation: blank(query.filter_runtime_location),
        userId: query.filter_user_id,
        keyId: blank(query.filter_key_id),
      },
    },
  };
};

const resolveView = (
  c: Ctx,
  params: PerformanceQueryParams,
): ResolvedTelemetryView | { error: 'forbidden' | 'bad_request'; message: string } => {
  const resolved = resolveTelemetryView(c, c.req.valid('query').view, params.keyId);
  if ('error' in resolved) return resolved;
  if (resolved.view === 'self-by-key' && params.groupBy === 'userId') {
    return { error: 'bad_request', message: 'group_by=userId is not allowed in self-by-key mode' };
  }
  return resolved;
};

const queryRecordsForView = async (
  resolved: ResolvedTelemetryView,
  params: PerformanceQueryParams,
  ownedKeyIds: ReadonlySet<string>,
): Promise<readonly PerformanceTelemetryRecord[] | null> => {
  const repo = getRepo();
  if (resolved.view === 'all-by-user') {
    return await repo.performance.query({
      start: params.start,
      end: params.end,
    });
  }

  if (params.keyId !== undefined && !ownedKeyIds.has(params.keyId)) {
    return null;
  }
  const rows = await repo.performance.query({
    keyId: params.keyId,
    start: params.start,
    end: params.end,
  });
  return params.keyId !== undefined ? rows : rows.filter(r => ownedKeyIds.has(r.keyId));
};

// Cross-cutting filter predicate applied at the raw-record level so every
// aggregation (chart series, summary, per-dimension breakdowns) reflects the
// same filtered view. Combining filters is AND. filter_user_id resolves via
// the key→user map because userId is not a native record column; orphan
// rows (hard-deleted key → keyToUser miss) never match a numeric user
// filter, matching the aggregation path's By-User grouping that also drops
// them rather than coercing undefined to 0. The caller pre-resolves `uid`
// once per row so this predicate — and the neighbouring dimension-value
// pass in `partitionRecords` — share a single Map.get per record.
const matchesFilters = (
  r: PerformanceTelemetryRecord,
  filters: PerformanceFilters,
  uid: number | undefined,
): boolean => {
  if (filters.model !== undefined && r.model !== filters.model) return false;
  if (filters.upstream !== undefined && r.upstream !== filters.upstream) return false;
  if (filters.operation !== undefined && r.operation !== filters.operation) return false;
  if (filters.runtimeLocation !== undefined && r.runtimeLocation !== filters.runtimeLocation) return false;
  if (filters.keyId !== undefined && r.keyId !== filters.keyId) return false;
  if (filters.userId !== undefined && uid !== filters.userId) return false;
  return true;
};

// Distinct values per dimension observed in the UNFILTERED record set so the
// dashboard dropdowns show the full menu regardless of which filters are
// currently applied. (Cross-filtering the dropdowns to the current selection
// would be a follow-up if the "hide options that would empty the result"
// UX becomes needed.)
interface DimensionValues {
  models: string[];
  upstreams: string[];
  operations: string[];
  runtimeLocations: string[];
  // keyIds / userIds are returned as their raw ids; the frontend joins to
  // the users/keys metadata below to render names. userIds is empty in
  // self-view — every self-view row belongs to the actor by construction,
  // so a single-element user dropdown carries no useful choice and the
  // dashboard hides that filter entirely for that view.
  keyIds: string[];
  userIds: number[];
}

// The overview handler needs both the filtered record set (feeds every
// aggregation) and the dimension-value dropdown menus (collected from
// UNFILTERED rows so filters never narrow the menu). One traversal
// produces both instead of walking the raw set twice.
const partitionRecords = (
  rows: readonly PerformanceTelemetryRecord[],
  filters: PerformanceFilters,
  keyToUser: ReadonlyMap<string, number>,
  includeUserIds: boolean,
): { filtered: readonly PerformanceTelemetryRecord[]; dimensionValues: DimensionValues } => {
  const models = new Set<string>();
  const upstreams = new Set<string>();
  const operations = new Set<string>();
  const runtimeLocations = new Set<string>();
  const keyIds = new Set<string>();
  const userIds = new Set<number>();
  const filtered: PerformanceTelemetryRecord[] = [];
  for (const r of rows) {
    models.add(r.model);
    upstreams.add(r.upstream);
    operations.add(r.operation);
    runtimeLocations.add(r.runtimeLocation);
    keyIds.add(r.keyId);
    // Orphan rows (hard-deleted key → keyToUser miss) don't contribute a
    // userId to the dropdown and cannot match a numeric user filter;
    // dropping them here mirrors the aggregation path's By-User grouping,
    // which also skips orphans rather than coercing undefined to 0. The
    // keyToUser lookup still runs unconditionally because matchesFilters
    // needs it to gate `filter_user_id` even in self-view.
    const uid = keyToUser.get(r.keyId);
    if (uid !== undefined && includeUserIds) userIds.add(uid);

    if (matchesFilters(r, filters, uid)) filtered.push(r);
  }
  return {
    filtered,
    dimensionValues: {
      models: [...models].sort(),
      upstreams: [...upstreams].sort(),
      operations: [...operations].sort(),
      runtimeLocations: [...runtimeLocations].sort(),
      keyIds: [...keyIds].sort(),
      userIds: [...userIds].sort((a, b) => a - b),
    },
  };
};

export const performanceOverview = async (c: Ctx) => {
  const params = readPerformanceQuery(c);
  if (params.type === 'error') return c.json({ error: params.error }, 400);

  const resolved = resolveView(c, params.value);
  if ('error' in resolved) return c.json({ error: resolved.message }, resolved.error === 'forbidden' ? 403 : 400);

  // One api_keys listing feeds every downstream concern in this handler:
  // the ownedKeyIds gate on the record query, the key→user map for
  // group_by=userId / filter_user_id, and the sorted keys[] block on
  // the response. Records and (all-by-user only) users then fan out
  // in parallel — six or seven pure-JS aggregations follow over the
  // same filtered array without touching D1 again.
  const repo = getRepo();
  const keysInfo = await loadTelemetryKeys(repo, resolved);
  const ownedKeyIds = new Set(keysInfo.keys.map(k => k.id));
  const [rawRecords, users] = await Promise.all([
    queryRecordsForView(resolved, params.value, ownedKeyIds),
    resolved.view === 'all-by-user' ? repo.users.listIncludingDeleted() : Promise.resolve([]),
  ]);
  if (rawRecords === null) return c.json({ error: 'Unknown key_id' }, 404);

  // API-key breakdown is available in both views; user breakdown is only
  // meaningful in all-by-user — every self-view row belongs to the actor
  // by construction, so both the By-User panel and the user-filter
  // dropdown are collapsed for that view. The by-user aggregation still
  // runs (its cost is negligible next to the O(N) records loop) and is
  // emptied at the response boundary; the dropdown values fold in at the
  // dimension-collection step.
  const includeUserRows = resolved.view === 'all-by-user';
  const { filtered, dimensionValues } = partitionRecords(rawRecords, params.value.filters, keysInfo.keyToUser, includeUserRows);

  const tzOnly = { timezoneOffsetMinutes: params.value.timezoneOffsetMinutes };
  // One traversal of `filtered` feeds every breakdown (chart series +
  // per-axis breakdown tables). The 'none' axis carries the summary row —
  // same all-buckets, no-groupBy aggregate the dashboard's summary stat
  // cards read.
  const axisBase = { ...tzOnly, keyToUser: keysInfo.keyToUser };
  const { series, ...axes } = aggregatePerformanceForDisplay(filtered, {
    series: { ...axisBase, bucket: params.value.bucket, groupBy: params.value.groupBy },
    none: { ...axisBase, bucket: 'all', groupBy: 'none' as const },
    model: { ...axisBase, bucket: 'all', groupBy: 'model' as const },
    upstream: { ...axisBase, bucket: 'all', groupBy: 'upstream' as const },
    runtimeLocation: { ...axisBase, bucket: 'all', groupBy: 'runtimeLocation' as const },
    operation: { ...axisBase, bucket: 'all', groupBy: 'operation' as const },
    keyId: { ...axisBase, bucket: 'all', groupBy: 'keyId' as const },
    userId: { ...axisBase, bucket: 'all', groupBy: 'userId' as const },
  });

  // User/key name metadata is always returned so the dashboard can render
  // usernames + key names in the By-User / By-API-key group column and in
  // the filter dropdowns — no include-flag negotiation, single source of
  // truth per view.
  const userMetadata = users
    .map(u => ({ id: u.id, username: u.username }))
    .sort((a, b) => a.id - b.id);
  const keys = keysInfo.keys
    .map(k => ({ id: k.id, name: k.name, createdAt: k.createdAt }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));

  return c.json({
    series,
    axes: {
      ...axes,
      // By-User panel is only meaningful in all-by-user; every self-view
      // row belongs to the actor by construction, so both the panel and
      // the user-filter dropdown are collapsed for that view.
      userId: includeUserRows ? axes.userId : [],
    },
    dimensionValues,
    users: userMetadata,
    keys,
  });
};
