// GET /api/performance/overview — dashboard aggregate: chart series, summary,
// six per-dimension breakdown tables, and dropdown menus, all built by the
// database overview aggregate.
//
// Resource and user breakdowns follow the same Audit visibility as token usage.
// Unfiltered non-key queries retain a global `none` axis as an explicit latency
// exception. API-key axes and key metadata stay scoped to the actor's own keys.

import { type CtxWithQuery } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import type { PerformanceOverviewGroupBy } from '../../repo/types.ts';
import type { performanceQuery } from '../schemas.ts';
import { loadTelemetryOverviewIdentity, readTelemetryOverviewWindow, telemetryIdentityError, telemetryIdentityMetadata, telemetryUpstreamMetadata } from '../shared/telemetry-overview.ts';
import { createTelemetryBucket, type TelemetryBucketGranularity } from '@floway-dev/protocols/common';

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
  groupBy: PerformanceOverviewGroupBy;
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
  const identityError = telemetryIdentityError(identity, filters.keyId);
  if (identityError !== null) return c.json({ error: identityError.error }, identityError.status);

  const query = {
    actorUserId: identity.actor.id,
    isAdmin: identity.actor.isAdmin,
    visibleUserIds: [...identity.visibleUserIds],
    visibleUpstreams: [...identity.visibleUpstreams],
    start,
    end,
    groupBy,
    filters: {
      keyIds: [...filters.keyId],
      userIds: [...filters.userId].map(Number),
      models: [...filters.model],
      upstreams: [...filters.upstream],
      operations: [...filters.operation],
      runtimeLocations: [...filters.runtimeLocation],
    },
    bucketForHour: createTelemetryBucket({
      bucket,
      start,
      timeZone: params.value.timeZone,
      timezoneOffsetMinutes,
    }),
  } as const;
  const [overview, global] = await Promise.all([
    repo.performance.queryOverview(query),
    identity.actor.isAdmin
      || groupBy === 'keyId'
      || Object.values(filters).some(values => values.size > 0)
      ? Promise.resolve(null)
      : repo.performance.queryOverview({
          ...query,
          isAdmin: true,
          visibleUserIds: [],
          visibleUpstreams: [],
          groupBy: 'model',
          filters: { keyIds: [], userIds: [], models: [], upstreams: [], operations: [], runtimeLocations: [] },
        }),
  ]);
  if (global) overview.axes.none = global.axes.none;
  const metadata = telemetryIdentityMetadata(identity, overview.dimensionValues.userIds);

  return c.json({
    ...overview,
    ...metadata,
    upstreams: telemetryUpstreamMetadata(identity, overview.dimensionValues.upstreams),
  });
};
