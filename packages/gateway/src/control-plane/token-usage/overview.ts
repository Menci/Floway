import { type CtxWithQuery } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import type { UsageOverviewGroupBy } from '../../repo/types.ts';
import type { tokenUsageOverviewQuery } from '../schemas.ts';
import { loadTelemetryOverviewIdentity, readTelemetryOverviewWindow, telemetryIdentityError, telemetryIdentityMetadata, telemetryUpstreamMetadata, type TelemetryOverviewIdentity } from '../shared/telemetry-overview.ts';
import type { TokenUsageOverviewResponse } from '../usage-types.ts';
import { createTelemetryBucket, parseTelemetryHour, TELEMETRY_HOUR_MS, telemetryHourKey, type TelemetryBucketGranularity, usageUpstreamFromDimensionValue } from '@floway-dev/protocols/common';

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
  cursor?: string;
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

const sorted = <T extends number | string>(values: Iterable<T>): T[] => [...values].sort();

const overviewScope = async (params: UsageOverviewParams, identity: TelemetryOverviewIdentity): Promise<string> => {
  const { bucket, groupBy, filters, timeZone, timezoneOffsetMinutes } = params;
  const fingerprint = JSON.stringify([
    bucket, groupBy, timeZone ?? timezoneOffsetMinutes, bucket.endsWith('d') ? params.start : null,
    sorted(filters.keyId), sorted(filters.userId), sorted(filters.model), sorted(filters.upstream),
    identity.actor.id, identity.actor.isAdmin, sorted(identity.ownedKeyIds),
    sorted(identity.visibleUserIds), sorted(identity.visibleUpstreams),
    identity.users.map(({ id, username }) => [id, username]),
    identity.upstreams.map(({ id, name, hue }) => [id, name, hue]),
  ]);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(fingerprint)));
  return Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('');
};

const readCursor = (cursor: string | undefined, scope: string) => {
  if (cursor === undefined) return null;
  const [signature, start, end, resumeFromHour, ...extra] = cursor.split('/');
  if (signature !== scope || !start || !end || !resumeFromHour || extra.length > 0) return null;
  try {
    if (parseTelemetryHour(start) > parseTelemetryHour(end)) return null;
    parseTelemetryHour(resumeFromHour);
    return { start, end, resumeFromHour };
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return null;
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

  const scope = await overviewScope(params.value, identity);
  const previous = readCursor(params.value.cursor, scope);
  const resumeFromHour = shiftHour(nowHour, -1);
  const nextHour = shiftHour(nowHour, 1);
  const coveredEnd = end < nextHour ? end : nextHour;
  const windowEnd = coveredEnd < start ? start : coveredEnd;
  const resume = previous !== null && start >= previous.start && windowEnd >= previous.end && resumeFromHour >= previous.resumeFromHour;
  let scanStart = start;
  if (resume) {
    const boundary = previous.resumeFromHour < previous.end ? previous.resumeFromHour : previous.end;
    if (boundary > scanStart) scanStart = boundary;
  }
  const chartBucketForHour = createTelemetryBucket({
    bucket, start, timeZone: params.value.timeZone, timezoneOffsetMinutes,
  });
  const hourlyBuckets = new Set([chartBucketForHour(resumeFromHour), chartBucketForHour(nowHour)]);
  if (resume && scanStart < windowEnd) hourlyBuckets.add(chartBucketForHour(scanStart));
  const boundaries = new Map<string, { bucket: string; start: string; end: string }>();
  const buckets = scanStart >= windowEnd ? [] : (await repo.usage.queryOverview({
    actorUserId: identity.actor.id,
    isAdmin: identity.actor.isAdmin,
    visibleUserIds: [...identity.visibleUserIds],
    visibleUpstreams: [...identity.visibleUpstreams],
    start: scanStart,
    end: windowEnd,
    groupBy,
    filters: {
      keyIds: [...filters.keyId],
      userIds: [...filters.userId].map(Number),
      models: [...filters.model],
      upstreams: [...filters.upstream],
    },
    bucketForHour: hour => {
      const chartBucket = chartBucketForHour(hour);
      const key = bucket === 'hour' || hourlyBuckets.has(chartBucket) ? `hour:${hour}` : `bucket:${chartBucket}`;
      const end = shiftHour(hour, 1);
      const bounds = boundaries.get(key);
      if (bounds === undefined) boundaries.set(key, { bucket: chartBucket, start: hour, end });
      else {
        if (hour < bounds.start) bounds.start = hour;
        if (end > bounds.end) bounds.end = end;
      }
      return key;
    },
  })).map(result => {
    const bounds = boundaries.get(result.bucket);
    if (!bounds) throw new Error('Usage overview bucket has no time bounds');
    return { ...result, ...bounds };
  })
    .sort((left, right) => left.start.localeCompare(right.start));
  const metadata = telemetryIdentityMetadata(identity, buckets.flatMap(value => value.dimensionValues.userIds));
  const revealedUpstreamIds = buckets.flatMap(value => value.dimensionValues.upstreams).flatMap(value => {
    const upstreamId = usageUpstreamFromDimensionValue(value);
    return upstreamId === null ? [] : [upstreamId];
  });

  return c.json({
    cursor: [scope, start, windowEnd, resumeFromHour].join('/'),
    reset: !resume,
    start: scanStart,
    end: windowEnd,
    buckets,
    ...metadata,
    visibleUserIds: [...identity.visibleUserIds],
    visibleUpstreamIds: [...identity.visibleUpstreams],
    upstreams: telemetryUpstreamMetadata(identity, revealedUpstreamIds),
  } satisfies TokenUsageOverviewResponse);
};
