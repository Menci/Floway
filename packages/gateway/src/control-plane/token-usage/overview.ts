import { aggregateUsageForOverview, usageUpstreamDimension, type UsageOverviewGroupBy } from './aggregate.ts';
import { type CtxWithQuery } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import type { tokenUsageOverviewQuery } from '../schemas.ts';
import { loadTelemetryOverviewIdentity, partitionTelemetryOverviewRecords, readTelemetryOverviewWindow, telemetryIdentityError, telemetryIdentityMetadata } from '../shared/telemetry-overview.ts';
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

  const rawRecords = await repo.usage.query({ start, end });
  const scopedRecords = !identity.actor.isAdmin || groupBy === 'keyId'
    ? rawRecords.filter(record => identity.ownedKeyIds.has(record.keyId))
    : rawRecords;
  const partitioned = partitionTelemetryOverviewRecords(scopedRecords, {
    keyId: {
      value: record => record.keyId,
      includeFacet: record => identity.ownedKeyIds.has(record.keyId),
    },
    userId: {
      value: record => identity.keyToUser.get(record.keyId)?.toString() ?? null,
      includeFacet: () => identity.actor.isAdmin,
    },
    model: { value: record => record.model },
    upstream: { value: record => usageUpstreamDimension(record.upstream) },
  }, filters);
  const { filtered } = partitioned;
  const dimensionValues = {
    keyIds: partitioned.dimensionValues.keyId,
    userIds: partitioned.dimensionValues.userId.map(Number).sort((left, right) => left - right),
    models: partitioned.dimensionValues.model,
    upstreams: partitioned.dimensionValues.upstream,
  };
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
