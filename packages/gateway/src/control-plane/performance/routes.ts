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

import { aggregatePerformanceForDisplay, type PerformanceGroupBy } from './aggregate.ts';
import { type CtxWithQuery } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import type { performanceQuery } from '../schemas.ts';
import type { TelemetryBucketGranularity } from '../shared/telemetry-bucket.ts';
import { loadTelemetryOverviewIdentity, partitionTelemetryOverviewRecords, readTelemetryOverviewWindow, telemetryIdentityError, telemetryIdentityMetadata } from '../shared/telemetry-overview.ts';

type Ctx = CtxWithQuery<typeof performanceQuery>;

interface PerformanceFilters {
  model: ReadonlySet<string>;
  upstream: ReadonlySet<string>;
  operation: ReadonlySet<string>;
  runtimeLocation: ReadonlySet<string>;
  userId: ReadonlySet<string>;
  keyId: ReadonlySet<string>;
}

interface PerformanceQueryParams {
  start: string;
  end: string;
  bucket: TelemetryBucketGranularity;
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
        userId: new Set(query.filter_user_id),
        keyId: new Set(query.filter_key_id),
      },
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

  const partitioned = partitionTelemetryOverviewRecords(scopedRecords, {
    model: { value: record => record.model },
    upstream: { value: record => record.upstream },
    operation: { value: record => record.operation },
    runtimeLocation: { value: record => record.runtimeLocation },
    userId: {
      value: record => identity.keyToUser.get(record.keyId)?.toString() ?? null,
      includeFacet: () => identity.actor.isAdmin,
    },
    keyId: {
      value: record => record.keyId,
      includeFacet: record => identity.ownedKeyIds.has(record.keyId),
    },
  }, filters);
  const { filtered } = partitioned;
  const dimensionValues = {
    models: partitioned.dimensionValues.model,
    upstreams: partitioned.dimensionValues.upstream,
    operations: partitioned.dimensionValues.operation,
    runtimeLocations: partitioned.dimensionValues.runtimeLocation,
    userIds: partitioned.dimensionValues.userId.map(Number).sort((left, right) => left - right),
    keyIds: partitioned.dimensionValues.keyId,
  };

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
