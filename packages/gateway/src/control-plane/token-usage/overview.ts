import { aggregateUsageForOverview, usageUpstreamDimension, type UsageOverviewGroupBy } from './aggregate.ts';
import { userFromContext } from '../../middleware/auth.ts';
import { type CtxWithQuery } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import type { UsageRecord } from '../../repo/types.ts';
import type { tokenUsageOverviewQuery } from '../schemas.ts';
import { buildKeyToUserMap } from '../shared/key-to-user.ts';
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
  timezoneOffsetMinutes: number;
  filters: UsageFilters;
}

const readUsageOverviewQuery = (
  c: Ctx,
): { type: 'ok'; value: UsageOverviewParams } | { type: 'error'; error: string } => {
  const query = c.req.valid('query');
  if (!query.start || !query.end) {
    return { type: 'error', error: 'start and end query parameters are required (e.g. 2026-03-09T00)' };
  }
  const timezoneOffsetMinutes = Number(query.timezone_offset_minutes ?? '0');
  if (!Number.isFinite(timezoneOffsetMinutes) || timezoneOffsetMinutes < -1440 || timezoneOffsetMinutes > 1440) {
    return { type: 'error', error: 'timezone_offset_minutes must be between -1440 and 1440' };
  }
  return {
    type: 'ok',
    value: {
      start: query.start,
      end: query.end,
      groupBy: query.group_by ?? 'model',
      bucket: query.bucket ?? 'hour',
      timezoneOffsetMinutes,
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
  const actor = userFromContext(c);
  if (!actor.isAdmin) {
    if (groupBy === 'userId') return c.json({ error: 'group_by=userId requires administrator privileges' }, 403);
    if (filters.userId.size > 0) return c.json({ error: 'filter_user_id requires administrator privileges' }, 403);
  }

  const repo = getRepo();
  const allKeys = await repo.apiKeys.listIncludingDeleted();
  const ownedKeys = allKeys.filter(key => key.userId === actor.id);
  const ownedKeyIds = new Set(ownedKeys.map(key => key.id));
  const unknownKeyId = [...filters.keyId].find(keyId => !ownedKeyIds.has(keyId));
  if (unknownKeyId !== undefined) return c.json({ error: 'Unknown filter_key_id' }, 404);

  const rawRecords = await repo.usage.query({ start, end });
  const scopedRecords = !actor.isAdmin || groupBy === 'keyId'
    ? rawRecords.filter(record => ownedKeyIds.has(record.keyId))
    : rawRecords;
  const users = actor.isAdmin ? await repo.users.listIncludingDeleted() : [];
  const keyToUser = buildKeyToUserMap(allKeys);
  const { filtered, dimensionValues } = partitionUsage(scopedRecords, filters, keyToUser, ownedKeyIds, actor.isAdmin);
  const tzOnly = { timezoneOffsetMinutes };
  const { series, ...axes } = aggregateUsageForOverview(filtered, {
    series: { ...tzOnly, bucket, groupBy },
    none: { ...tzOnly, bucket: 'all', groupBy: 'none' },
    keyId: { ...tzOnly, bucket: 'all', groupBy: 'keyId' },
    userId: { ...tzOnly, bucket: 'all', groupBy: 'userId' },
    model: { ...tzOnly, bucket: 'all', groupBy: 'model' },
    upstream: { ...tzOnly, bucket: 'all', groupBy: 'upstream' },
  }, keyToUser, ownedKeyIds);

  return c.json({
    series,
    axes: { ...axes, userId: actor.isAdmin ? axes.userId : [] },
    dimensionValues,
    users: users.map(user => ({ id: user.id, username: user.username })).sort((left, right) => left.id - right.id),
    keys: ownedKeys
      .map(key => ({ id: key.id, name: key.name, createdAt: key.createdAt }))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)),
  } satisfies TokenUsageOverviewResponse);
};
