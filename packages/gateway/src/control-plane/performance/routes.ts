// GET /api/performance/overview — dashboard aggregate: chart series, summary,
// six per-dimension breakdown tables, and dropdown menus, all built by the
// database overview aggregate.
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

import { type CtxWithQuery } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import type { PerformanceOverviewGroupBy } from '../../repo/types.ts';
import type { performanceQuery } from '../schemas.ts';
import { createTelemetryBucket, type TelemetryBucketGranularity } from '../shared/telemetry-bucket.ts';
import { loadTelemetryOverviewIdentity, readTelemetryOverviewWindow, telemetryIdentityError, telemetryIdentityMetadata } from '../shared/telemetry-overview.ts';

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
  const identityError = telemetryIdentityError(identity, groupBy, filters.userId, filters.keyId);
  if (identityError !== null) return c.json({ error: identityError.error }, identityError.status);

  const overview = await repo.performance.queryOverview({
    actorUserId: identity.actor.id,
    isAdmin: identity.actor.isAdmin,
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
      timeZone: params.value.timeZone,
      timezoneOffsetMinutes,
    }),
  });
  const metadata = telemetryIdentityMetadata(identity);

  return c.json({
    ...overview,
    ...metadata,
  });
};
