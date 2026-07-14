// GET /api/performance/overview — dashboard aggregate: chart series, summary,
// six per-dimension breakdown tables, and dropdown menus, all built from a
// single raw record query.
//
// View semantics mirror /api/token-usage and /api/search-usage:
// - `self-by-key` scopes every axis to the actor's keys (active +
//   soft-deleted). `group_by=userId` is rejected because every row belongs to
//   the actor.
// - `all-by-user` uses every row for global and per-user axes, while API-key
//   axes, metadata, and filters remain scoped to the actor's own keys.

import { aggregatePerformanceForDisplay, type PerformanceBucketGranularity, type PerformanceGroupBy } from './aggregate.ts';
import { userFromContext } from '../../middleware/auth.ts';
import { type CtxWithQuery } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import type { PerformanceTelemetryRecord } from '../../repo/types.ts';
import type { performanceQuery } from '../schemas.ts';
import { buildKeyToUserMap, loadTelemetryKeys, resolveTelemetryView, type ResolvedTelemetryView } from '../telemetry-view.ts';

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
        userId: blank(query.filter_user_id) === undefined ? undefined : Number(query.filter_user_id),
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

// Distinct values per dimension observed in the UNFILTERED record set so the
// dashboard dropdowns show the full menu regardless of which filters are
// currently applied.
interface DimensionValues {
  models: string[];
  upstreams: string[];
  operations: string[];
  runtimeLocations: string[];
  // The frontend joins these raw ids to the users/keys metadata below.
  // keyIds always belongs to the actor; userIds spans all users only in the
  // global view and stays empty in self-view.
  keyIds: string[];
  userIds: number[];
}

// One traversal produces two outputs: the filtered record set that feeds
// every downstream aggregation (chart series, summary, per-dimension
// breakdowns), and the dimension-value dropdown menus collected from the
// UNFILTERED rows so filters never narrow the menu. Filters AND together;
// `filter_user_id` resolves via the key→user map because userId is not a
// native record column, and orphan rows (hard-deleted key → keyToUser
// miss) never match a numeric user filter — matching the aggregation
// path's By-User grouping that also drops them rather than coercing
// undefined to 0.
const partitionRecords = (
  rows: readonly PerformanceTelemetryRecord[],
  filters: PerformanceFilters,
  keyToUser: ReadonlyMap<string, number>,
  visibleKeyIds: ReadonlySet<string>,
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
    if (visibleKeyIds.has(r.keyId)) keyIds.add(r.keyId);
    const uid = keyToUser.get(r.keyId);
    if (uid !== undefined && includeUserIds) userIds.add(uid);

    if (filters.model !== undefined && r.model !== filters.model) continue;
    if (filters.upstream !== undefined && r.upstream !== filters.upstream) continue;
    if (filters.operation !== undefined && r.operation !== filters.operation) continue;
    if (filters.runtimeLocation !== undefined && r.runtimeLocation !== filters.runtimeLocation) continue;
    if (filters.keyId !== undefined && r.keyId !== filters.keyId) continue;
    if (filters.userId !== undefined && uid !== filters.userId) continue;
    filtered.push(r);
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

  const repo = getRepo();
  const allKeys = await loadTelemetryKeys(repo, resolved);
  const actorUserId = userFromContext(c).id;
  const ownedKeys = allKeys.filter(key => key.userId === actorUserId);
  const ownedKeyIds = new Set(ownedKeys.map(key => key.id));
  if (resolved.view === 'all-by-user' && params.value.filters.keyId !== undefined && !ownedKeyIds.has(params.value.filters.keyId)) {
    return c.json({ error: 'Unknown filter_key_id' }, 404);
  }

  const rawRecords = await queryRecordsForView(resolved, params.value, ownedKeyIds);
  if (rawRecords === null) return c.json({ error: 'Unknown key_id' }, 404);

  const includeUserRows = resolved.view === 'all-by-user';
  const users = includeUserRows ? await repo.users.listIncludingDeleted() : [];
  const keyToUser = buildKeyToUserMap(allKeys);
  const { filtered, dimensionValues } = partitionRecords(rawRecords, params.value.filters, keyToUser, ownedKeyIds, includeUserRows);

  const tzOnly = { timezoneOffsetMinutes: params.value.timezoneOffsetMinutes };
  const { series, ...axes } = aggregatePerformanceForDisplay(filtered, {
    series: { ...tzOnly, bucket: params.value.bucket, groupBy: params.value.groupBy },
    // 'none' axis carries the summary row.
    none: { ...tzOnly, bucket: 'all', groupBy: 'none' as const },
    model: { ...tzOnly, bucket: 'all', groupBy: 'model' as const },
    upstream: { ...tzOnly, bucket: 'all', groupBy: 'upstream' as const },
    runtimeLocation: { ...tzOnly, bucket: 'all', groupBy: 'runtimeLocation' as const },
    operation: { ...tzOnly, bucket: 'all', groupBy: 'operation' as const },
    keyId: { ...tzOnly, bucket: 'all', groupBy: 'keyId' as const },
    userId: { ...tzOnly, bucket: 'all', groupBy: 'userId' as const },
  }, keyToUser, ownedKeyIds);

  // Global views expose user metadata for By User, while key metadata remains
  // actor-owned for By API Key and its filter.
  const userMetadata = users
    .map(u => ({ id: u.id, username: u.username }))
    .sort((a, b) => a.id - b.id);
  const keys = ownedKeys
    .map(k => ({ id: k.id, name: k.name, createdAt: k.createdAt }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));

  return c.json({
    series,
    axes: {
      ...axes,
      userId: includeUserRows ? axes.userId : [],
    },
    dimensionValues,
    users: userMetadata,
    keys,
  });
};
