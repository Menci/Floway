import { type CtxWithQuery } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import type { UsageOverviewGroupBy } from '../../repo/types.ts';
import type { tokenUsageOverviewQuery } from '../schemas.ts';
import { loadTelemetryOverviewIdentity, readTelemetryOverviewWindow, telemetryIdentityError, telemetryIdentityMetadata, telemetryUpstreamMetadata } from '../shared/telemetry-overview.ts';
import type { TokenUsageOverviewResponse } from '../usage-types.ts';
import { createTelemetryBucket, type TelemetryBucketGranularity, usageUpstreamFromDimensionValue } from '@floway-dev/protocols/common';

type Ctx = CtxWithQuery<typeof tokenUsageOverviewQuery>;

interface UsageFilters {
  keyId: ReadonlySet<string>;
  userId: ReadonlySet<string>;
  model: ReadonlySet<string>;
  upstream: ReadonlySet<string>;
}

interface UsageOverviewParams {
  start: string;
  end: string;
  groupBy: UsageOverviewGroupBy;
  bucket: TelemetryBucketGranularity;
  timeZone?: string;
  timezoneOffsetMinutes: number;
  filters: UsageFilters;
}

const readUsageOverviewQuery = (
  c: Ctx,
): { type: 'ok'; value: UsageOverviewParams } | { type: 'error'; error: string } => {
  const query = c.req.valid('query');
  const window = readTelemetryOverviewWindow(query);
  if (window.type === 'error') return window;
  return {
    type: 'ok',
    value: {
      ...window.value,
      groupBy: query.group_by ?? 'model',
      filters: {
        keyId: new Set(query.filter_key_id),
        userId: new Set(query.filter_user_id),
        model: new Set(query.filter_model),
        upstream: new Set(query.filter_upstream),
      },
    },
  };
};

export const tokenUsageOverview = async (c: Ctx) => {
  const params = readUsageOverviewQuery(c);
  if (params.type === 'error') return c.json({ error: params.error }, 400);
  const { start, end, groupBy, bucket, timezoneOffsetMinutes, filters } = params.value;
  const repo = getRepo();
  const identity = await loadTelemetryOverviewIdentity(c);
  const identityError = telemetryIdentityError(identity, filters.keyId);
  if (identityError !== null) return c.json({ error: identityError.error }, identityError.status);

  const overview = await repo.usage.queryOverview({
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
    },
    bucketForHour: createTelemetryBucket({
      bucket,
      start,
      timeZone: params.value.timeZone,
      timezoneOffsetMinutes,
    }),
  });
  const metadata = telemetryIdentityMetadata(identity, overview.dimensionValues.userIds);
  const revealedUpstreamIds = overview.dimensionValues.upstreams.flatMap(value => {
    const upstreamId = usageUpstreamFromDimensionValue(value);
    return upstreamId === null ? [] : [upstreamId];
  });

  return c.json({
    ...overview,
    ...metadata,
    // The same user set the response already names: User.Audit targets plus
    // users revealed by visible upstream rows. The dashboard uses this to
    // choose the search-usage view, so it must not disagree with `users`.
    auditableUserIds: metadata.users.map(user => user.id),
    upstreams: telemetryUpstreamMetadata(identity, revealedUpstreamIds),
  } satisfies TokenUsageOverviewResponse);
};
