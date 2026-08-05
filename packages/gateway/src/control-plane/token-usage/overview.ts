import { aggregateUsageForOverview, usageUpstreamDimension, type UsageOverviewGroupBy } from './aggregate.ts';
import { type CtxWithQuery } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import type { UsageRecord } from '../../repo/types.ts';
import type { tokenUsageOverviewQuery } from '../schemas.ts';
import { loadTelemetryOverviewIdentity, readTelemetryOverviewWindow, telemetryIdentityError, telemetryIdentityMetadata } from '../shared/telemetry-overview.ts';
import type { TokenUsageOverviewResponse } from '../usage-types.ts';

type Ctx = CtxWithQuery<typeof tokenUsageOverviewQuery>;

interface UsageFilters {
  keyId: ReadonlySet<string>;
  userId: ReadonlySet<number>;
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
        userId: new Set(query.filter_user_id?.map(Number)),
        model: new Set(query.filter_model),
        upstream: new Set(query.filter_upstream),
      },
    },
  };
};

const partitionUsage = (
  records: readonly UsageRecord[],
  filters: UsageFilters,
  keyToUser: ReadonlyMap<string, number>,
  visibleKeyIds: ReadonlySet<string>,
  includeUserIds: boolean,
) => {
  const keyIds = new Set<string>();
  const userIds = new Set<number>();
  const models = new Set<string>();
  const upstreams = new Set<string>();
  const filtered: UsageRecord[] = [];
  for (const record of records) {
    if (visibleKeyIds.has(record.keyId)) keyIds.add(record.keyId);
    const userId = keyToUser.get(record.keyId);
    if (includeUserIds && userId !== undefined) userIds.add(userId);
    models.add(record.model);
    const upstream = usageUpstreamDimension(record.upstream);
    upstreams.add(upstream);

    if (filters.keyId.size > 0 && !filters.keyId.has(record.keyId)) continue;
    if (filters.userId.size > 0 && (userId === undefined || !filters.userId.has(userId))) continue;
    if (filters.model.size > 0 && !filters.model.has(record.model)) continue;
    if (filters.upstream.size > 0 && !filters.upstream.has(upstream)) continue;
    filtered.push(record);
  }
  return {
    filtered,
    dimensionValues: {
      keyIds: [...keyIds].sort(),
      userIds: [...userIds].sort((left, right) => left - right),
      models: [...models].sort(),
      upstreams: [...upstreams].sort(),
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

  const rawRecords = await repo.usage.query({ start, end });
  const scopedRecords = !identity.actor.isAdmin || groupBy === 'keyId'
    ? rawRecords.filter(record => identity.ownedKeyIds.has(record.keyId))
    : rawRecords;
  const { filtered, dimensionValues } = partitionUsage(scopedRecords, filters, identity.keyToUser, identity.ownedKeyIds, identity.actor.isAdmin);
  const tzOnly = { timeZone: params.value.timeZone, timezoneOffsetMinutes };
  const { series, ...axes } = aggregateUsageForOverview(filtered, {
    series: { ...tzOnly, bucket, groupBy },
    none: { ...tzOnly, bucket: 'all', groupBy: 'none' },
    keyId: { ...tzOnly, bucket: 'all', groupBy: 'keyId' },
    userId: { ...tzOnly, bucket: 'all', groupBy: 'userId' },
    model: { ...tzOnly, bucket: 'all', groupBy: 'model' },
    upstream: { ...tzOnly, bucket: 'all', groupBy: 'upstream' },
  }, identity.keyToUser, identity.ownedKeyIds);
  const metadata = telemetryIdentityMetadata(identity);

  return c.json({
    series,
    axes: { ...axes, userId: identity.actor.isAdmin ? axes.userId : [] },
    dimensionValues,
    ...metadata,
  } satisfies TokenUsageOverviewResponse);
};
