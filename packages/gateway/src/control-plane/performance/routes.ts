// GET /api/performance/overview — dashboard aggregate: chart series, summary,
// six per-dimension breakdown tables, and dropdown menus, all built from a
// single raw record query.
//
// The requested breakdown decides the scope. `group_by=keyId` is inherently a
// question about the actor's own traffic, so it aggregates the actor's keys
// (active + soft-deleted) alone; every other breakdown — including the `model`
// default — aggregates all users' rows. Latency is not sensitive on its own, so
// that cross-user read is open to every user.
//
// Per-user attribution is the administrator-only part — the By-User rows, the
// username listing, the userId dropdown, `group_by=userId`, and
// `filter_user_id`. A regular user sees the whole picture without learning who
// produced which row. API-key axes, key metadata, and `filter_key_id` stay
// scoped to the actor's own keys in every breakdown, so other users' key ids
// never surface either.

import { aggregatePerformanceForDisplay, type PerformanceBucketGranularity, type PerformanceGroupBy } from './aggregate.ts';
import { type CtxWithQuery } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import type { PerformanceTelemetryRecord } from '../../repo/types.ts';
import type { performanceQuery } from '../schemas.ts';
import { loadTelemetryOverviewIdentity, readTelemetryOverviewWindow, telemetryIdentityError, telemetryIdentityMetadata } from '../shared/telemetry-overview.ts';

type Ctx = CtxWithQuery<typeof performanceQuery>;

interface PerformanceFilters {
  model: ReadonlySet<string>;
  upstream: ReadonlySet<string>;
  operation: ReadonlySet<string>;
  runtimeLocation: ReadonlySet<string>;
  userId: ReadonlySet<number>;
  keyId: ReadonlySet<string>;
}

interface PerformanceQueryParams {
  start: string;
  end: string;
  bucket: PerformanceBucketGranularity;
  groupBy: PerformanceGroupBy;
  timeZone?: string;
  timezoneOffsetMinutes: number;
  filters: PerformanceFilters;
}

const readPerformanceQuery = (
  c: Ctx,
): { type: 'ok'; value: PerformanceQueryParams } | { type: 'error'; error: string } => {
  const query = c.req.valid('query');
  const window = readTelemetryOverviewWindow(query);
  if (window.type === 'error') return window;

  return {
    type: 'ok',
    value: {
      ...window.value,
      groupBy: query.group_by ?? 'model',
      filters: {
        model: new Set(query.filter_model),
        upstream: new Set(query.filter_upstream),
        operation: new Set(query.filter_operation),
        runtimeLocation: new Set(query.filter_runtime_location),
        userId: new Set(query.filter_user_id?.map(Number)),
        keyId: new Set(query.filter_key_id),
      },
    },
  };
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
  // keyIds always belongs to the actor; userIds is populated only when the
  // caller may attribute rows to users, and stays empty otherwise.
  keyIds: string[];
  userIds: number[];
}

// One traversal produces two outputs: the filtered record set that feeds
// every downstream aggregation (chart series, summary, per-dimension
// breakdowns), and the dimension-value dropdown menus collected from the
// UNFILTERED rows so filters never narrow the menu. Values within one filter
// are OR'd and the filters AND together; an empty filter is the absence of a
// constraint on its dimension. `filter_user_id` resolves via the key→user map
// because userId is not a native record column, and orphan rows (hard-deleted
// key → keyToUser miss) never match a numeric user filter — matching the
// aggregation path's By-User grouping that also drops them rather than
// coercing undefined to 0.
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

    if (filters.model.size > 0 && !filters.model.has(r.model)) continue;
    if (filters.upstream.size > 0 && !filters.upstream.has(r.upstream)) continue;
    if (filters.operation.size > 0 && !filters.operation.has(r.operation)) continue;
    if (filters.runtimeLocation.size > 0 && !filters.runtimeLocation.has(r.runtimeLocation)) continue;
    if (filters.keyId.size > 0 && !filters.keyId.has(r.keyId)) continue;
    if (filters.userId.size > 0 && (uid === undefined || !filters.userId.has(uid))) continue;
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
  const { start, end, bucket, groupBy, timezoneOffsetMinutes, filters } = params.value;

  const repo = getRepo();
  const identity = await loadTelemetryOverviewIdentity(c);
  const identityError = telemetryIdentityError(identity, groupBy, filters.userId, filters.keyId);
  if (identityError !== null) return c.json({ error: identityError.error }, identityError.status);

  const rawRecords = await repo.performance.query({ start, end });
  const scopedRecords = groupBy === 'keyId'
    ? rawRecords.filter(r => identity.ownedKeyIds.has(r.keyId))
    : rawRecords;

  const { filtered, dimensionValues } = partitionRecords(scopedRecords, filters, identity.keyToUser, identity.ownedKeyIds, identity.actor.isAdmin);

  const tzOnly = { timeZone: params.value.timeZone, timezoneOffsetMinutes };
  const { series, ...axes } = aggregatePerformanceForDisplay(filtered, {
    series: { ...tzOnly, bucket, groupBy },
    // 'none' axis carries the summary row.
    none: { ...tzOnly, bucket: 'all', groupBy: 'none' as const },
    model: { ...tzOnly, bucket: 'all', groupBy: 'model' as const },
    upstream: { ...tzOnly, bucket: 'all', groupBy: 'upstream' as const },
    runtimeLocation: { ...tzOnly, bucket: 'all', groupBy: 'runtimeLocation' as const },
    operation: { ...tzOnly, bucket: 'all', groupBy: 'operation' as const },
    keyId: { ...tzOnly, bucket: 'all', groupBy: 'keyId' as const },
    userId: { ...tzOnly, bucket: 'all', groupBy: 'userId' as const },
  }, identity.keyToUser, identity.ownedKeyIds);
  const metadata = telemetryIdentityMetadata(identity);

  return c.json({
    series,
    axes: {
      ...axes,
      userId: identity.actor.isAdmin ? axes.userId : [],
    },
    dimensionValues,
    ...metadata,
  });
};
