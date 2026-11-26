import type { PerformanceSliceRow, PerformanceSlicesResponse } from './types.ts';
import { type CtxWithQuery } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import { overviewBucketKey } from '../../repo/telemetry-bucket-sql.ts';
import type { PerformanceDisplayRecord, PerformanceOverviewGroupBy, PerformanceSliceQuery, PerformanceSliceRecord } from '../../repo/types.ts';
import type { performanceQuery } from '../schemas.ts';
import { loadTelemetryOverviewIdentity, planTelemetrySlices, readTelemetryOverviewWindow, shiftTelemetryHour, telemetryIdentityError, telemetryIdentityMetadata, telemetryOverviewVisibility, telemetryUpstreamMetadata, type TelemetryOverviewIdentity, type TelemetryOverviewWindow } from '../shared/telemetry-overview.ts';
import { createTelemetryBucket, parseTelemetryHour, percentileFromBuckets, telemetryBucketHours } from '@floway-dev/protocols/common';

type Ctx = CtxWithQuery<typeof performanceQuery>;

interface PerformanceFilters {
  model: ReadonlySet<string>;
  upstream: ReadonlySet<string>;
  operation: ReadonlySet<string>;
  runtimeLocation: ReadonlySet<string>;
  userId: ReadonlySet<string>;
  keyId: ReadonlySet<string>;
}

interface PerformanceQueryParams extends TelemetryOverviewWindow {
  groupBy: PerformanceOverviewGroupBy;
  filters: PerformanceFilters;
}

const displayGlobalSummary = (record: PerformanceSliceRecord): PerformanceDisplayRecord => {
  const { buckets, ...counters } = record;
  const ttft = buckets.filter(value => value.metric === 'ttft_ms');
  const tpot = buckets.filter(value => value.metric === 'tpot_us');
  return {
    ...counters, bucket: 'all',
    ttftMsP50: percentileFromBuckets(ttft, 0.5), ttftMsP95: percentileFromBuckets(ttft, 0.95), ttftMsP99: percentileFromBuckets(ttft, 0.99),
    tpotUsP50: percentileFromBuckets(tpot, 0.5), tpotUsP95: percentileFromBuckets(tpot, 0.95), tpotUsP99: percentileFromBuckets(tpot, 0.99),
  };
};

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

const performanceSlices = async (
  c: Ctx,
  params: PerformanceQueryParams,
  query: Omit<PerformanceSliceQuery, 'dimension' | 'bucket' | 'hourlyBuckets' | 'includeTotals' | 'includeFacets'>,
  identity: TelemetryOverviewIdentity,
  useGlobalSummary: boolean,
) => {
  const { bucket, start, end } = params;
  if (bucket === 'month' || bucket === 'year' || bucket === 'all') return c.json({ error: 'Performance slices require fixed-width buckets' }, 400);
  const request = c.req.valid('query');
  const dimension = request.dimension ?? params.groupBy;
  const includeSummary = dimension === params.groupBy;
  const previous = request.cursor;
  if (previous !== undefined) {
    try { parseTelemetryHour(previous); } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      return c.json({ error: 'Cursor must be a valid UTC hour' }, 400);
    }
  }
  const nowHour = new Date().toISOString().slice(0, 13);
  const grid = { origin: start, hours: telemetryBucketHours(bucket) };
  const { scanStart, windowEnd, cursor, reset, hourlyBuckets } = planTelemetrySlices(start, end, nowHour, previous, grid);
  const repo = getRepo().performance;
  const [slices, global] = await Promise.all([
    scanStart >= windowEnd ? [] : repo.querySlices({
      ...query, start: scanStart, end: windowEnd, dimension, bucket: grid, hourlyBuckets,
      includeTotals: includeSummary && !useGlobalSummary, includeFacets: includeSummary,
    }),
    includeSummary && useGlobalSummary && start < windowEnd ? repo.querySlices({
      ...query, end: windowEnd, isAdmin: true, dimension: 'none', bucket: 'all', hourlyBuckets: [],
      includeTotals: false, includeFacets: false,
    }) : [],
  ]);
  const edges: PerformanceSlicesResponse['edges'] = { ttft_ms: [], tpot_us: [] };
  const indices = { ttft_ms: new Map<number, number>(), tpot_us: new Map<number, number>() };
  const encode = ({ buckets, ...rest }: PerformanceSliceRecord): PerformanceSliceRow => {
    const ttft: PerformanceSliceRow['ttft'] = [];
    const tpot: PerformanceSliceRow['tpot'] = [];
    for (const { metric, lower, upper, count } of buckets) {
      const byBound = indices[metric];
      let idx = byBound.get(lower);
      if (idx === undefined) {
        idx = edges[metric].length;
        edges[metric].push([lower, upper]);
        byBound.set(lower, idx);
      }
      (metric === 'ttft_ms' ? ttft : tpot).push([idx, count]);
    }
    return { ...rest, ttft, tpot };
  };
  const buckets = slices.map(slice => ({
    bucket: overviewBucketKey(grid, slice.firstHour),
    start: slice.firstHour,
    end: shiftTelemetryHour(slice.lastHour, 1),
    rows: slice.rows.map(encode),
    ...(slice.total === undefined ? {} : { total: encode(slice.total) }),
    dimensionValues: slice.dimensionValues,
  }));
  const revealedUsers = slices.flatMap(slice => slice.dimensionValues.userIds);
  const revealedUpstreams = slices.flatMap(slice => slice.dimensionValues.upstreams);
  if (dimension === 'userId') revealedUsers.push(...slices.flatMap(slice => slice.rows.map(row => Number(row.group))));
  if (dimension === 'upstream') revealedUpstreams.push(...slices.flatMap(slice => slice.rows.map(row => row.group)));
  const globalRecord = global[0]?.rows[0];
  return c.json({
    start: scanStart, end: windowEnd, cursor, reset, buckets, edges,
    ...telemetryOverviewVisibility(identity, query.ownedKeysOnly),
    ...telemetryIdentityMetadata(identity, revealedUsers),
    upstreams: telemetryUpstreamMetadata(identity, revealedUpstreams),
    ...(includeSummary && useGlobalSummary ? { globalSummary: globalRecord === undefined ? null : displayGlobalSummary(globalRecord) } : {}),
  } satisfies PerformanceSlicesResponse);
};

export const performanceOverview = async (c: Ctx) => {
  const params = readPerformanceQuery(c);
  if (params.type === 'error') return c.json({ error: params.error }, 400);
  const { start, end, bucket, groupBy, timezoneOffsetMinutes, filters } = params.value;

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
    filters: {
      keyIds: [...filters.keyId],
      userIds: [...filters.userId].map(Number),
      models: [...filters.model],
      upstreams: [...filters.upstream],
      operations: [...filters.operation],
      runtimeLocations: [...filters.runtimeLocation],
    },
  } as const;
  // An unfiltered non-Key view may show a global summary. Buckets remain within
  // Audit visibility, and Key data is limited to the actor's keys.
  const useGlobalSummary = !identity.actor.isAdmin && groupBy !== 'keyId'
    && Object.values(filters).every(values => values.size === 0);
  if (c.req.valid('query').format === 'buckets') {
    return await performanceSlices(c, params.value, { ...query, ownedKeysOnly: groupBy === 'keyId' }, identity, useGlobalSummary);
  }
  const repo = getRepo().performance;
  const overviewQuery = {
    ...query, groupBy,
    bucketForHour: createTelemetryBucket({ bucket, start, timeZone: params.value.timeZone, timezoneOffsetMinutes }),
  };
  const [overview, global] = await Promise.all([
    repo.queryOverview(overviewQuery),
    useGlobalSummary
      ? repo.queryOverview({
          ...overviewQuery,
          isAdmin: true,
          visibleUserIds: [],
          visibleUpstreams: [],
          groupBy: 'model',
          filters: { keyIds: [], userIds: [], models: [], upstreams: [], operations: [], runtimeLocations: [] },
        })
      : Promise.resolve(null),
  ]);
  if (global) overview.axes.none = global.axes.none;
  const metadata = telemetryIdentityMetadata(identity, overview.dimensionValues.userIds);

  return c.json({
    ...overview,
    ...metadata,
    upstreams: telemetryUpstreamMetadata(identity, overview.dimensionValues.upstreams),
  });
};
