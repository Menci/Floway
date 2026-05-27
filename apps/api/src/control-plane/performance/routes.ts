// GET /api/performance — query backend-aggregated latency telemetry.
// Visibility intentionally mirrors /api/token-usage: any authenticated user can
// view shared usage/performance records for dashboard observability.

import { aggregatePerformanceForDisplay, type PerformanceBucketGranularity, type PerformanceGroupBy } from './aggregate.ts';
import { type CtxWithQuery } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import type { PerformanceMetricScope } from '../../repo/types.ts';
import type { performanceQuery } from '../schemas.ts';
import { USAGE_KEY_COLOR_ORDER } from '../usage-key-colors.ts';

type Ctx = CtxWithQuery<typeof performanceQuery>;

interface PerformanceQueryParams {
  keyId: string | undefined;
  start: string;
  end: string;
  bucket: PerformanceBucketGranularity;
  groupBy: PerformanceGroupBy;
  metricScope: PerformanceMetricScope;
  timezoneOffsetMinutes: number;
}

// Schema-validated query → handler-facing params. Returns the canonical
// "start and end query parameters are required" message rather than a generic
// zod-shaped error to preserve the existing dashboard inline-error UX.
const readPerformanceQuery = (
  c: Ctx,
  defaults: { bucket: PerformanceBucketGranularity; groupBy: PerformanceGroupBy },
): { type: 'ok'; value: PerformanceQueryParams } | { type: 'error'; error: string } => {
  const query = c.req.valid('query');
  const start = query.start ?? '';
  const end = query.end ?? '';
  if (!start || !end) {
    return { type: 'error', error: 'start and end query parameters are required (e.g. 2026-03-09T00)' };
  }

  const timezoneOffsetMinutes = Number(query.timezone_offset_minutes ?? '0');
  if (!Number.isFinite(timezoneOffsetMinutes) || timezoneOffsetMinutes < -1440 || timezoneOffsetMinutes > 1440) {
    return { type: 'error', error: 'timezone_offset_minutes must be between -1440 and 1440' };
  }

  return {
    type: 'ok',
    value: {
      keyId: query.key_id === '' ? undefined : query.key_id,
      start,
      end,
      bucket: query.bucket ?? defaults.bucket,
      groupBy: query.group_by ?? defaults.groupBy,
      metricScope: query.metric_scope ?? 'request_total',
      timezoneOffsetMinutes,
    },
  };
};

export const performanceTelemetry = async (c: Ctx) => {
  const params = readPerformanceQuery(c, { bucket: 'hour', groupBy: 'model' });
  if (params.type === 'error') return c.json({ error: params.error }, 400);

  const includeKeyMetadata = c.req.valid('query').include_key_metadata === '1';

  const rawRecords = await getRepo().performance.query({
    keyId: params.value.keyId,
    start: params.value.start,
    end: params.value.end,
    metricScope: params.value.metricScope,
  });
  const records = aggregatePerformanceForDisplay(rawRecords, {
    bucket: params.value.bucket,
    groupBy: params.value.groupBy,
    timezoneOffsetMinutes: params.value.timezoneOffsetMinutes,
  });

  if (!includeKeyMetadata) return c.json({ records });

  const keys = await getRepo().apiKeys.list();
  const keyMetadata = keys.map(k => ({ id: k.id, name: k.name, createdAt: k.createdAt })).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return c.json({
    records,
    keys: keyMetadata,
    keyColorOrder: USAGE_KEY_COLOR_ORDER,
  });
};

export const performanceOverview = async (c: Ctx) => {
  const params = readPerformanceQuery(c, { bucket: 'hour', groupBy: 'model' });
  if (params.type === 'error') return c.json({ error: params.error }, 400);

  const rawRecords = await getRepo().performance.query({
    keyId: params.value.keyId,
    start: params.value.start,
    end: params.value.end,
    metricScope: params.value.metricScope,
  });
  const baseOptions = { timezoneOffsetMinutes: params.value.timezoneOffsetMinutes };

  return c.json({
    series: aggregatePerformanceForDisplay(rawRecords, { ...baseOptions, bucket: params.value.bucket, groupBy: 'model' }),
    summaryRows: aggregatePerformanceForDisplay(rawRecords, { ...baseOptions, bucket: 'all', groupBy: 'none' }),
    modelRows: aggregatePerformanceForDisplay(rawRecords, { ...baseOptions, bucket: 'all', groupBy: 'model' }),
    runtimeRows: aggregatePerformanceForDisplay(rawRecords, { ...baseOptions, bucket: 'all', groupBy: 'runtimeLocation' }),
  });
};
