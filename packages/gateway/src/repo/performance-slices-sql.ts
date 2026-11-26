import { overviewGroupSql, performanceCoordinateSql, performanceFiltersSql, performanceRangeBinds, performanceVisibilitySql, scopedRange } from './performance-overview-sql.ts';
import { overviewBucketBinds, overviewBucketSql, type OverviewBucketId } from './telemetry-bucket-sql.ts';
import type { PerformanceQuerySlice, PerformanceSliceQuery } from './types.ts';
import type { SqlDatabase } from '@floway-dev/platform';
import { parsePerformanceOperation } from '@floway-dev/provider';

const dimensions = ['model', 'upstream', 'operation', 'runtimeLocation', 'userId', 'keyId'] as const;
const facetValuesSql = dimensions.map(axis => `('${axis}')`).join(', ');

const sliceSql = (query: PerformanceSliceQuery) => `/* performance-slices */
WITH settings(
  actor_user_id, is_admin, dimension, include_totals, include_facets, models_json, upstreams_json,
  operations_json, runtimes_json, users_json, keys_json, visible_users_json, visible_upstreams_json,
  bucket_origin, bucket_seconds, bucket_offset_seconds, hourly_buckets
) AS (VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)),
authorized AS MATERIALIZED (
  SELECT performance_summary.*, api_keys.user_id, settings.actor_user_id = api_keys.user_id AS owned,
    ${overviewBucketSql(query.bucket, 'performance_summary.hour')} AS chart_bucket
  FROM performance_summary
  CROSS JOIN settings
  LEFT JOIN api_keys ON api_keys.id = performance_summary.key_id
  WHERE ${scopedRange('performance_summary', query.ownedKeysOnly)}
    AND (${performanceVisibilitySql})
),
sliced AS MATERIALIZED (
  SELECT authorized.*, CASE WHEN chart_bucket IN (SELECT value FROM json_each((SELECT hourly_buckets FROM settings)))
    THEN hour ELSE chart_bucket END AS bucket
  FROM authorized
),
axes(axis) AS (
  SELECT dimension FROM settings UNION ALL SELECT 'none' FROM settings WHERE include_totals
),
projected AS MATERIALIZED (
  SELECT sliced.*, axes.axis, ${overviewGroupSql('sliced', 'axes.axis')} AS group_value
  FROM sliced
  CROSS JOIN axes
  CROSS JOIN settings
  WHERE (axes.axis != 'keyId' OR owned)
    AND (axes.axis != 'userId' OR user_id IS NOT NULL)
    AND ${performanceFiltersSql}
),
summaries AS (
  SELECT 'summary' AS kind, axis, bucket, group_value, MIN(hour) AS first_hour, MAX(hour) AS last_hour,
    json_array(CAST(SUM(requests) AS TEXT), CAST(SUM(errors_with_output + errors_no_output) AS TEXT),
      CAST(SUM(ttft_samples_ok + errors_with_output) AS TEXT), CAST(SUM(tpot_samples) AS TEXT), CAST(SUM(neutral) AS TEXT)) AS payload
  FROM projected GROUP BY axis, bucket, group_value
),
histograms AS (
  SELECT 'histogram' AS kind, projected.axis, projected.bucket, projected.group_value, NULL AS first_hour, NULL AS last_hour,
    json_array(metric, lower, upper, CAST(SUM(count) AS TEXT)) AS payload
  FROM projected JOIN performance_buckets ON ${performanceCoordinateSql('projected', 'performance_buckets')}
  GROUP BY axis, bucket, group_value, metric, lower, upper
),
facet_axes(axis) AS (VALUES ${facetValuesSql}),
facets AS (
  SELECT 'facet' AS kind, facet_axes.axis, sliced.bucket, ${overviewGroupSql('sliced', 'facet_axes.axis')} AS group_value,
    MIN(hour) AS first_hour, MAX(hour) AS last_hour, NULL AS payload
  FROM settings
  CROSS JOIN sliced
  CROSS JOIN facet_axes
  WHERE settings.include_facets
    AND (facet_axes.axis != 'keyId' OR owned)
    AND (facet_axes.axis != 'userId' OR user_id IS NOT NULL)
  GROUP BY facet_axes.axis, sliced.bucket, group_value
),
orphan AS (
  SELECT 'orphan' AS kind, NULL AS axis, NULL AS bucket, NULL AS group_value,
    NULL AS first_hour, NULL AS last_hour, NULL AS payload
  FROM performance_buckets
  LEFT JOIN performance_summary ON ${performanceCoordinateSql('performance_buckets', 'performance_summary')}
  WHERE ${scopedRange('performance_buckets', query.ownedKeysOnly)}
    AND performance_summary.hour IS NULL
  LIMIT 1
)
SELECT * FROM summaries UNION ALL SELECT * FROM facets UNION ALL SELECT * FROM histograms UNION ALL SELECT * FROM orphan
ORDER BY kind DESC, bucket, axis, group_value`;

type SliceRow = { kind: 'orphan' } | ({
  axis: string;
  bucket: OverviewBucketId;
  group_value: string;
} & ({ kind: 'histogram'; payload: string } | {
  first_hour: string;
  last_hour: string;
} & ({ kind: 'summary'; payload: string } | { kind: 'facet' })));

const sliceRowKey = (row: Exclude<SliceRow, { kind: 'orphan' }>) => JSON.stringify([row.bucket, row.axis, row.group_value]);

const safeCount = (value: string): number => {
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed)) throw new RangeError('Performance count exceeds the safe integer range');
  return parsed;
};

const finishSlices = (rows: readonly SliceRow[], dimension: PerformanceSliceQuery['dimension']): PerformanceQuerySlice[] => {
  const slices = new Map<OverviewBucketId, PerformanceQuerySlice>();
  const items = new Map<string, PerformanceQuerySlice['rows'][number]>();
  const bounds = new Map<string, number | null>();
  for (const row of rows) {
    if (row.kind === 'orphan') throw new Error('performance_buckets row has no matching summary');
    if (row.kind === 'histogram') {
      const item = items.get(sliceRowKey(row));
      if (item === undefined) throw new Error('Performance histogram has no summary');
      const [metric, lower, upper, count] = JSON.parse(row.payload) as ['ttft_ms' | 'tpot_us', number, number | null, string];
      const boundKey = `${metric}:${lower}`;
      const existing = bounds.get(boundKey);
      if (existing !== undefined && existing !== upper) throw new Error('performance_buckets rows disagree on histogram bounds');
      bounds.set(boundKey, upper);
      item.buckets.push({ metric, lower, upper, count: safeCount(count) });
      continue;
    }
    let slice = slices.get(row.bucket);
    if (slice === undefined) {
      slice = {
        firstHour: row.first_hour, lastHour: row.last_hour, rows: [],
        dimensionValues: { models: [], upstreams: [], operations: [], runtimeLocations: [], userIds: [], keyIds: [] },
      };
      slices.set(row.bucket, slice);
    }
    if (row.first_hour < slice.firstHour) slice.firstHour = row.first_hour;
    if (row.last_hour > slice.lastHour) slice.lastHour = row.last_hour;
    if (row.kind === 'facet') {
      const { dimensionValues } = slice;
      const value = row.group_value;
      switch (row.axis) {
      case 'model': dimensionValues.models.push(value); break;
      case 'upstream': dimensionValues.upstreams.push(value); break;
      case 'operation': dimensionValues.operations.push(parsePerformanceOperation(value)); break;
      case 'runtimeLocation': dimensionValues.runtimeLocations.push(value); break;
      case 'userId': dimensionValues.userIds.push(Number(value)); break;
      case 'keyId': dimensionValues.keyIds.push(value); break;
      default: throw new Error('Performance slice has an invalid facet');
      }
      continue;
    }
    const [requests, errors, ttftSamples, tpotSamples, neutral] = (JSON.parse(row.payload) as [string, string, string, string, string]).map(safeCount) as [number, number, number, number, number];
    const item = { group: row.group_value, requests, errors, ttftSamples, tpotSamples, neutral, buckets: [] };
    if (row.axis === dimension) slice.rows.push(item);
    else slice.total = item;
    items.set(sliceRowKey(row), item);
  }
  return [...slices.values()].sort((a, b) => a.firstHour.localeCompare(b.firstHour));
};

export const querySqlPerformanceSlices = async (db: SqlDatabase, query: PerformanceSliceQuery): Promise<PerformanceQuerySlice[]> => {
  const range = performanceRangeBinds(query, query.ownedKeysOnly);
  const { filters } = query;
  const { results } = await db.prepare(sliceSql(query)).bind(
    query.actorUserId, query.isAdmin ? 1 : 0, query.dimension, query.includeTotals ? 1 : 0, query.includeFacets ? 1 : 0,
    JSON.stringify(filters.models), JSON.stringify(filters.upstreams), JSON.stringify(filters.operations),
    JSON.stringify(filters.runtimeLocations), JSON.stringify(filters.userIds), JSON.stringify(filters.keyIds),
    JSON.stringify(query.visibleUserIds), JSON.stringify(query.visibleUpstreams),
    ...overviewBucketBinds(query.bucket), JSON.stringify(query.hourlyBuckets), ...range, ...range,
  ).all<SliceRow>();
  return finishSlices(results, query.dimension);
};
