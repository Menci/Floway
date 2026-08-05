import { createTelemetryBucket } from '../shared/telemetry-bucket.ts';
import { type CtxWithQuery } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import type { UsageOverviewGroupBy } from '../../repo/types.ts';
import { loadTelemetryOverviewIdentity, readTelemetryOverviewWindow, telemetryIdentityError, telemetryIdentityMetadata } from '../shared/telemetry-overview.ts';
import type { tokenUsageOverviewQuery } from '../schemas.ts';
import type { TokenUsageOverviewResponse } from '../usage-types.ts';

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
  bucket: 'hour' | '4h' | '8h' | 'day' | 'all';
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
  const identityError = telemetryIdentityError(identity, groupBy, filters.userId, filters.keyId);
  if (identityError !== null) return c.json({ error: identityError.error }, identityError.status);

  const overview = await repo.usage.queryOverview({
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
    },
    keyToUser: identity.keyToUser,
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
  } satisfies TokenUsageOverviewResponse);
};
