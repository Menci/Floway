import { type CtxWithQuery } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import { overviewBucketKey, type OverviewBucket } from '../../repo/telemetry-bucket-sql.ts';
import type { UsageOverviewGroupBy } from '../../repo/types.ts';
import type { tokenUsageOverviewQuery } from '../schemas.ts';
import { loadTelemetryOverviewIdentity, readTelemetryOverviewWindow, telemetryIdentityError, telemetryIdentityMetadata, telemetryUpstreamMetadata, type TelemetryOverviewWindow } from '../shared/telemetry-overview.ts';
import type { TokenUsageOverviewResponse } from '../usage-types.ts';
import { parseTelemetryHour, TELEMETRY_HOUR_MS, telemetryBucketHours, telemetryHourKey, usageUpstreamFromDimensionValue } from '@floway-dev/protocols/common';

type Ctx = CtxWithQuery<typeof tokenUsageOverviewQuery>;

interface UsageFilters {
  keyId: ReadonlySet<string>;
  userId: ReadonlySet<string>;
  model: ReadonlySet<string>;
  upstream: ReadonlySet<string>;
}

interface UsageOverviewParams extends TelemetryOverviewWindow {
  groupBy: UsageOverviewGroupBy;
  filters: UsageFilters;
  cursor: string | undefined;
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
      cursor: query.cursor,
      filters: {
        keyId: new Set(query.filter_key_id),
        userId: new Set(query.filter_user_id),
        model: new Set(query.filter_model),
        upstream: new Set(query.filter_upstream),
      },
    },
  };
};

const shiftHour = (hour: string, count: number): string =>
  telemetryHourKey(parseTelemetryHour(hour) + count * TELEMETRY_HOUR_MS);

const readCursor = (cursor: string | undefined): string | undefined => {
  if (cursor === undefined) return undefined;
  try {
    parseTelemetryHour(cursor);
    return cursor;
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return undefined;
  }
};

export const tokenUsageOverview = async (c: Ctx) => {
  const nowHour = new Date().toISOString().slice(0, 13);
  const params = readUsageOverviewQuery(c);
  if (params.type === 'error') return c.json({ error: params.error }, 400);
  const { start, end, groupBy, bucket, timezoneOffsetMinutes, filters } = params.value;
  const repo = getRepo();
  const identity = await loadTelemetryOverviewIdentity(c);
  const identityError = telemetryIdentityError(identity, filters.keyId);
  if (identityError !== null) return c.json({ error: identityError.error }, identityError.status);
  const ownedKeysOnly = groupBy === 'keyId';
  // The dashboard compares the serialized scope across reads, so set order is canonical.
  const userIds = [...identity.visibleUserIds].sort((left, right) => left - right);
  const upstreamIds = [...identity.visibleUpstreams].sort();

  const previous = readCursor(params.value.cursor);
  const resumeFromHour = shiftHour(nowHour, -1);
  const nextHour = shiftHour(nowHour, 1);
  const coveredEnd = end < nextHour ? end : nextHour;
  const windowEnd = coveredEnd < start ? start : coveredEnd;
  const cursor = windowEnd < resumeFromHour ? windowEnd : resumeFromHour;
  const resume = previous !== undefined && previous <= cursor;
  const scanStart = resume && previous > start ? previous : start;
  const queryBucket: OverviewBucket = bucket === 'all' ? 'all' : bucket === 'month' || bucket === 'year'
    ? { calendar: bucket, timezoneOffsetMinutes }
    : { origin: start, hours: telemetryBucketHours(bucket) };
  const hourlyBoundaries = resume ? [resumeFromHour, nowHour, scanStart] : [resumeFromHour, nowHour];
  const hourlyBuckets = hourlyBoundaries
    .filter(hour => hour >= scanStart && hour < windowEnd)
    .map(hour => overviewBucketKey(queryBucket, hour));
  const buckets = scanStart >= windowEnd ? [] : (await repo.usage.queryOverview({
    actorUserId: identity.actor.id,
    isAdmin: identity.actor.isAdmin,
    visibleUserIds: userIds,
    visibleUpstreams: upstreamIds,
    start: scanStart,
    end: windowEnd,
    ownedKeysOnly,
    filters: {
      keyIds: [...filters.keyId],
      userIds: [...filters.userId].map(Number),
      models: [...filters.model],
      upstreams: [...filters.upstream],
    },
    bucket: queryBucket,
    hourlyBuckets,
  })).map(({ firstHour, lastHour, axes, dimensionValues }) => ({
    bucket: overviewBucketKey(queryBucket, firstHour),
    start: firstHour,
    end: shiftHour(lastHour, 1),
    axes,
    dimensionValues,
  }))
    .sort((left, right) => left.start.localeCompare(right.start));
  const metadata = telemetryIdentityMetadata(identity, buckets.flatMap(value => value.dimensionValues.userIds));
  const revealedUpstreamIds = buckets.flatMap(value => value.dimensionValues.upstreams).flatMap(value => {
    const upstreamId = usageUpstreamFromDimensionValue(value);
    return upstreamId === null ? [] : [upstreamId];
  });

  return c.json({
    cursor,
    reset: !resume,
    start: scanStart,
    end: windowEnd,
    buckets,
    ...metadata,
    scope: {
      actorId: identity.actor.id,
      ownedKeyIds: [...identity.ownedKeyIds].sort(),
      visibility: ownedKeysOnly ? 'owned-keys' : identity.actor.isAdmin ? 'all' : { userIds, upstreamIds },
    },
    metadataVisibility: { complete: identity.actor.isAdmin, userIds, upstreamIds },
    upstreams: telemetryUpstreamMetadata(identity, revealedUpstreamIds),
  } satisfies TokenUsageOverviewResponse);
};
