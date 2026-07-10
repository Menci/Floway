// GET /api/performance — query backend-aggregated latency telemetry.
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
import { resolveTelemetryView, type ResolvedTelemetryView } from '../telemetry-view.ts';

type Ctx = CtxWithQuery<typeof performanceQuery>;

interface PerformanceFilters {
  model: string | undefined;
  upstream: string | undefined;
  operation: string | undefined;
  runtimeLocation: string | undefined;
  userId: string | undefined;
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
        userId: blank(query.filter_user_id),
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
): Promise<readonly PerformanceTelemetryRecord[] | null> => {
  const repo = getRepo();
  if (resolved.view === 'all-by-user') {
    return await repo.performance.query({
      start: params.start,
      end: params.end,
    });
  }

  const ownedIds = await repo.apiKeys.idsByUserIdIncludingDeleted(resolved.scopeUserId);
  const ownedSet = new Set(ownedIds);
  if (params.keyId !== undefined && !ownedSet.has(params.keyId)) {
    return null;
  }
  const rows = await repo.performance.query({
    keyId: params.keyId,
    start: params.start,
    end: params.end,
  });
  return params.keyId !== undefined ? rows : rows.filter(r => ownedSet.has(r.keyId));
};

const buildKeyToUserMap = async (): Promise<ReadonlyMap<string, number>> => {
  const keys = await getRepo().apiKeys.listIncludingDeleted();
  return new Map(keys.map(k => [k.id, k.userId] as const));
};

// Apply cross-cutting filters at the raw-record level so every aggregation
// (chart series, summary, per-dimension breakdowns) reflects the same
// filtered view. Combining filters is AND. filter_user_id filters via the
// key→user map (userId is not a native record column).
const applyFilters = (
  rows: readonly PerformanceTelemetryRecord[],
  filters: PerformanceFilters,
  keyToUser: ReadonlyMap<string, number> | null,
): readonly PerformanceTelemetryRecord[] => {
  if (
    filters.model === undefined &&
    filters.upstream === undefined &&
    filters.operation === undefined &&
    filters.runtimeLocation === undefined &&
    filters.userId === undefined &&
    filters.keyId === undefined
  ) {
    return rows;
  }
  const wantUserId = filters.userId === undefined ? null : Number(filters.userId);
  return rows.filter(r => {
    if (filters.model !== undefined && r.model !== filters.model) return false;
    if (filters.upstream !== undefined && r.upstream !== filters.upstream) return false;
    if (filters.operation !== undefined && r.operation !== filters.operation) return false;
    if (filters.runtimeLocation !== undefined && r.runtimeLocation !== filters.runtimeLocation) return false;
    if (filters.keyId !== undefined && r.keyId !== filters.keyId) return false;
    if (wantUserId !== null) {
      const uid = keyToUser?.get(r.keyId);
      if (uid !== wantUserId) return false;
    }
    return true;
  });
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
  // the users/keys metadata below to render names.
  keyIds: string[];
  userIds: number[];
}

const collectDimensionValues = (
  rows: readonly PerformanceTelemetryRecord[],
  keyToUser: ReadonlyMap<string, number> | null,
): DimensionValues => {
  const models = new Set<string>();
  const upstreams = new Set<string>();
  const operations = new Set<string>();
  const runtimeLocations = new Set<string>();
  const keyIds = new Set<string>();
  const userIds = new Set<number>();
  for (const r of rows) {
    models.add(r.model);
    upstreams.add(r.upstream);
    operations.add(r.operation);
    runtimeLocations.add(r.runtimeLocation);
    keyIds.add(r.keyId);
    const uid = keyToUser?.get(r.keyId);
    if (uid !== undefined) userIds.add(uid);
  }
  return {
    models: [...models].sort(),
    upstreams: [...upstreams].sort(),
    operations: [...operations].sort(),
    runtimeLocations: [...runtimeLocations].sort(),
    keyIds: [...keyIds].sort(),
    userIds: [...userIds].sort((a, b) => a - b),
  };
};

export const performanceTelemetry = async (c: Ctx) => {
  const params = readPerformanceQuery(c);
  if (params.type === 'error') return c.json({ error: params.error }, 400);

  const resolved = resolveView(c, params.value);
  if ('error' in resolved) return c.json({ error: resolved.message }, resolved.error === 'forbidden' ? 403 : 400);

  const rawRecords = await queryRecordsForView(resolved, params.value);
  if (rawRecords === null) return c.json({ error: 'Unknown key_id' }, 404);

  const keyToUser = params.value.groupBy === 'userId' || params.value.filters.userId !== undefined ? await buildKeyToUserMap() : null;
  const filtered = applyFilters(rawRecords, params.value.filters, keyToUser);

  const baseOptions = { bucket: params.value.bucket, timezoneOffsetMinutes: params.value.timezoneOffsetMinutes };
  const records = aggregatePerformanceForDisplay(
    filtered,
    params.value.groupBy === 'userId'
      ? { ...baseOptions, groupBy: 'userId', keyToUser: keyToUser! }
      : { ...baseOptions, groupBy: params.value.groupBy },
  );

  const query = c.req.valid('query');
  const repo = getRepo();

  if (resolved.view === 'all-by-user') {
    if (query.include_user_metadata !== '1') return c.json({ records });
    const users = await repo.users.listIncludingDeleted();
    const userMetadata = users
      .map(u => ({ id: u.id, username: u.username }))
      .sort((a, b) => a.id - b.id);
    return c.json({ records, users: userMetadata });
  }

  if (query.include_key_metadata !== '1') return c.json({ records });
  const keys = await repo.apiKeys.listByUserIdIncludingDeleted(resolved.scopeUserId);
  const keyMetadata = keys.map(k => ({ id: k.id, name: k.name, createdAt: k.createdAt }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return c.json({ records, keys: keyMetadata });
};

export const performanceOverview = async (c: Ctx) => {
  const params = readPerformanceQuery(c);
  if (params.type === 'error') return c.json({ error: params.error }, 400);

  const resolved = resolveView(c, params.value);
  if ('error' in resolved) return c.json({ error: resolved.message }, resolved.error === 'forbidden' ? 403 : 400);

  const rawRecords = await queryRecordsForView(resolved, params.value);
  if (rawRecords === null) return c.json({ error: 'Unknown key_id' }, 404);

  // keyToUser is needed whenever the response mentions user ids — for the
  // user-id filter, for group_by=userId, or for the dimensionValues.userIds
  // list (always populated so the dropdown has content).
  const keyToUser = await buildKeyToUserMap();
  const dimensionValues = collectDimensionValues(rawRecords, keyToUser);
  const filtered = applyFilters(rawRecords, params.value.filters, keyToUser);

  const baseOptions = { timezoneOffsetMinutes: params.value.timezoneOffsetMinutes };
  const series = aggregatePerformanceForDisplay(
    filtered,
    params.value.groupBy === 'userId'
      ? { ...baseOptions, bucket: params.value.bucket, groupBy: 'userId', keyToUser }
      : { ...baseOptions, bucket: params.value.bucket, groupBy: params.value.groupBy },
  );
  const summaryRows = aggregatePerformanceForDisplay(filtered, { ...baseOptions, bucket: 'all', groupBy: 'none' });
  const modelRows = aggregatePerformanceForDisplay(filtered, { ...baseOptions, bucket: 'all', groupBy: 'model' });
  const upstreamRows = aggregatePerformanceForDisplay(filtered, { ...baseOptions, bucket: 'all', groupBy: 'upstream' });
  const runtimeRows = aggregatePerformanceForDisplay(filtered, { ...baseOptions, bucket: 'all', groupBy: 'runtimeLocation' });
  const operationRows = aggregatePerformanceForDisplay(filtered, { ...baseOptions, bucket: 'all', groupBy: 'operation' });
  // API-key breakdown is available in both views; the admin view sees every
  // user's keys (name metadata below lists them all), the self view only sees
  // the actor's. User breakdown is only meaningful in the admin view — every
  // self-view row belongs to the actor by construction.
  const keyRows = aggregatePerformanceForDisplay(filtered, { ...baseOptions, bucket: 'all', groupBy: 'keyId' });
  const userRows = resolved.view === 'all-by-user'
    ? aggregatePerformanceForDisplay(filtered, { ...baseOptions, bucket: 'all', groupBy: 'userId', keyToUser })
    : [];

  const repo = getRepo();
  // User/key name metadata is always returned so the dashboard can render
  // usernames + key names in the By-User / By-API-key group column and in
  // the filter dropdowns — no include-flag negotiation, single source of
  // truth per view.
  const users = resolved.view === 'all-by-user'
    ? (await repo.users.listIncludingDeleted())
        .map(u => ({ id: u.id, username: u.username }))
        .sort((a, b) => a.id - b.id)
    : [];
  const keyList = resolved.view === 'all-by-user'
    ? await repo.apiKeys.listIncludingDeleted()
    : await repo.apiKeys.listByUserIdIncludingDeleted(resolved.scopeUserId);
  const keys = keyList
    .map(k => ({ id: k.id, name: k.name, createdAt: k.createdAt }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));

  return c.json({
    series,
    summaryRows,
    modelRows,
    upstreamRows,
    runtimeRows,
    operationRows,
    keyRows,
    userRows,
    dimensionValues,
    users,
    keys,
  });
};
