import type {
  PerformanceDisplayRecord,
  PerformanceOverviewAxis,
  PerformanceOverviewQueryOptions,
  PerformanceOverviewResult,
} from './types.ts';
import type { SqlBindValue, SqlDatabase } from '@floway-dev/platform';
import { parsePerformanceOperation } from '@floway-dev/provider';

interface PerformanceOverviewSqlRow {
  row_kind: 'aggregate' | 'facet' | 'missing_hour' | 'orphan';
  axis: string | null;
  bucket: string | null;
  group_value: string | null;
  dimension: string | null;
  facet_value: string | null;
  requests_text: string | null;
  errors_text: string | null;
  ttft_samples_text: string | null;
  tpot_samples_text: string | null;
  neutral_text: string | null;
  ttft_ms_p50: number | null;
  ttft_ms_p95: number | null;
  ttft_ms_p99: number | null;
  tpot_us_p50: number | null;
  tpot_us_p95: number | null;
  tpot_us_p99: number | null;
}

const overviewAxes = new Set<PerformanceOverviewAxis>([
  'series', 'none', 'keyId', 'userId', 'model', 'upstream', 'operation', 'runtimeLocation',
]);
const overviewDimensions = new Set([
  'keyId', 'userId', 'model', 'upstream', 'operation', 'runtimeLocation',
]);

const scopedRange = (table: string, scoped: boolean) => scoped
  ? `${table}.key_id IN (SELECT id FROM api_keys WHERE user_id = ?) AND ${table}.hour >= ? AND ${table}.hour < ?`
  : `${table}.hour >= ? AND ${table}.hour < ?`;

const rangeBinds = (opts: PerformanceOverviewQueryOptions, scoped: boolean): SqlBindValue[] => scoped
  ? [opts.actorUserId, opts.start, opts.end]
  : [opts.start, opts.end];

const overviewSql = (scoped: boolean) => `/* performance-overview */
WITH
settings(actor_user_id, is_admin, series_group_by) AS (
  VALUES (?, ?, ?)
),
model_filter(value) AS MATERIALIZED (
  SELECT CAST(value AS TEXT) FROM json_each(?)
),
upstream_filter(value) AS MATERIALIZED (
  SELECT CAST(value AS TEXT) FROM json_each(?)
),
operation_filter(value) AS MATERIALIZED (
  SELECT CAST(value AS TEXT) FROM json_each(?)
),
runtime_filter(value) AS MATERIALIZED (
  SELECT CAST(value AS TEXT) FROM json_each(?)
),
user_filter(value) AS MATERIALIZED (
  SELECT CAST(value AS INTEGER) FROM json_each(?)
),
key_filter(value) AS MATERIALIZED (
  SELECT CAST(value AS TEXT) FROM json_each(?)
),
bucket_map(hour, bucket) AS MATERIALIZED (
  SELECT key, CAST(value AS TEXT) FROM json_each(?)
),
scoped_summary AS MATERIALIZED (
  SELECT
    performance_summary.*,
    api_keys.user_id,
    CASE WHEN api_keys.user_id = settings.actor_user_id THEN 1 ELSE 0 END AS owned
  FROM performance_summary
  CROSS JOIN settings
  LEFT JOIN api_keys ON api_keys.id = performance_summary.key_id
  WHERE ${scopedRange('performance_summary', scoped)}
),
orphan_buckets AS MATERIALIZED (
  SELECT 1 AS present
  FROM performance_buckets
  LEFT JOIN performance_summary ON
    performance_summary.hour = performance_buckets.hour
    AND performance_summary.key_id = performance_buckets.key_id
    AND performance_summary.model = performance_buckets.model
    AND performance_summary.upstream = performance_buckets.upstream
    AND performance_summary.operation = performance_buckets.operation
    AND performance_summary.runtime_location = performance_buckets.runtime_location
  WHERE ${scopedRange('performance_buckets', scoped)}
    AND performance_summary.hour IS NULL
  LIMIT 1
),
filtered_summary AS MATERIALIZED (
  SELECT *
  FROM scoped_summary
  WHERE
    (NOT EXISTS (SELECT 1 FROM model_filter) OR model IN (SELECT value FROM model_filter))
    AND (NOT EXISTS (SELECT 1 FROM upstream_filter) OR upstream IN (SELECT value FROM upstream_filter))
    AND (NOT EXISTS (SELECT 1 FROM operation_filter) OR operation IN (SELECT value FROM operation_filter))
    AND (NOT EXISTS (SELECT 1 FROM runtime_filter) OR runtime_location IN (SELECT value FROM runtime_filter))
    AND (NOT EXISTS (SELECT 1 FROM user_filter) OR user_id IN (SELECT value FROM user_filter))
    AND (NOT EXISTS (SELECT 1 FROM key_filter) OR key_id IN (SELECT value FROM key_filter))
),
axes(axis, grouping, bucketed, owned_only, admin_only) AS (
  SELECT 'series', series_group_by, 1, 0, 0 FROM settings
  UNION ALL SELECT 'none', 'none', 0, 0, 0
  UNION ALL SELECT 'keyId', 'keyId', 0, 1, 0
  UNION ALL SELECT 'userId', 'userId', 0, 0, 1
  UNION ALL SELECT 'model', 'model', 0, 0, 0
  UNION ALL SELECT 'upstream', 'upstream', 0, 0, 0
  UNION ALL SELECT 'operation', 'operation', 0, 0, 0
  UNION ALL SELECT 'runtimeLocation', 'runtimeLocation', 0, 0, 0
),
projected_summary AS MATERIALIZED (
  SELECT
    filtered_summary.*,
    axes.axis,
    CASE WHEN axes.bucketed = 1 THEN bucket_map.bucket ELSE 'all' END AS bucket,
    CASE axes.grouping
      WHEN 'none' THEN 'all'
      WHEN 'keyId' THEN filtered_summary.key_id
      WHEN 'userId' THEN CAST(filtered_summary.user_id AS TEXT)
      WHEN 'model' THEN filtered_summary.model
      WHEN 'upstream' THEN filtered_summary.upstream
      WHEN 'operation' THEN filtered_summary.operation
      WHEN 'runtimeLocation' THEN filtered_summary.runtime_location
    END AS group_value
  FROM filtered_summary
  CROSS JOIN axes
  CROSS JOIN settings
  JOIN bucket_map ON bucket_map.hour = filtered_summary.hour
  WHERE (axes.owned_only = 0 OR filtered_summary.owned = 1)
    AND (axes.admin_only = 0 OR settings.is_admin = 1)
    AND (axes.grouping != 'userId' OR filtered_summary.user_id IS NOT NULL)
),
summary_aggregates AS MATERIALIZED (
  SELECT
    axis,
    bucket,
    group_value,
    SUM(requests) AS requests,
    SUM(errors_with_output) + SUM(errors_no_output) AS errors,
    SUM(ttft_samples_ok) + SUM(errors_with_output) AS ttft_samples,
    SUM(tpot_samples) AS tpot_samples,
    SUM(neutral) AS neutral
  FROM projected_summary
  GROUP BY axis, bucket, group_value
),
projected_histogram AS MATERIALIZED (
  SELECT
    projected_summary.axis,
    projected_summary.bucket,
    projected_summary.group_value,
    performance_buckets.metric,
    performance_buckets.lower,
    performance_buckets.upper,
    performance_buckets.count
  FROM projected_summary
  JOIN performance_buckets ON
    performance_buckets.hour = projected_summary.hour
    AND performance_buckets.key_id = projected_summary.key_id
    AND performance_buckets.model = projected_summary.model
    AND performance_buckets.upstream = projected_summary.upstream
    AND performance_buckets.operation = projected_summary.operation
    AND performance_buckets.runtime_location = projected_summary.runtime_location
),
histogram AS MATERIALIZED (
  SELECT axis, bucket, group_value, metric, lower, upper, SUM(count) AS count
  FROM projected_histogram
  GROUP BY axis, bucket, group_value, metric, lower, upper
),
ranked_histogram AS MATERIALIZED (
  SELECT
    histogram.*,
    SUM(count) OVER (
      PARTITION BY axis, bucket, group_value, metric
    ) AS total,
    COALESCE(SUM(count) OVER (
      PARTITION BY axis, bucket, group_value, metric
      ORDER BY upper IS NULL, upper, lower
      ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
    ), 0) AS seen
  FROM histogram
),
percentiles(label, numerator) AS (
  VALUES ('p50', 50), ('p95', 95), ('p99', 99)
),
selected_percentiles AS MATERIALIZED (
  SELECT
    ranked_histogram.axis,
    ranked_histogram.bucket,
    ranked_histogram.group_value,
    ranked_histogram.metric,
    percentiles.label,
    CASE
      WHEN ranked_histogram.upper IS NULL THEN ranked_histogram.lower
      ELSE ranked_histogram.lower
        + (ranked_histogram.upper - ranked_histogram.lower) * 1.0
        * (((ranked_histogram.total * percentiles.numerator + 99) / 100) - ranked_histogram.seen)
        / (ranked_histogram.count + 1)
    END AS value
  FROM ranked_histogram
  CROSS JOIN percentiles
  WHERE ranked_histogram.total > 0
    AND ranked_histogram.seen < ((ranked_histogram.total * percentiles.numerator + 99) / 100)
    AND ranked_histogram.seen + ranked_histogram.count >= ((ranked_histogram.total * percentiles.numerator + 99) / 100)
),
percentile_values AS MATERIALIZED (
  SELECT
    axis,
    bucket,
    group_value,
    MAX(CASE WHEN metric = 'ttft_ms' AND label = 'p50' THEN value END) AS ttft_ms_p50,
    MAX(CASE WHEN metric = 'ttft_ms' AND label = 'p95' THEN value END) AS ttft_ms_p95,
    MAX(CASE WHEN metric = 'ttft_ms' AND label = 'p99' THEN value END) AS ttft_ms_p99,
    MAX(CASE WHEN metric = 'tpot_us' AND label = 'p50' THEN value END) AS tpot_us_p50,
    MAX(CASE WHEN metric = 'tpot_us' AND label = 'p95' THEN value END) AS tpot_us_p95,
    MAX(CASE WHEN metric = 'tpot_us' AND label = 'p99' THEN value END) AS tpot_us_p99
  FROM selected_percentiles
  GROUP BY axis, bucket, group_value
),
aggregate_rows AS (
  SELECT
    'aggregate' AS row_kind,
    summary_aggregates.axis,
    summary_aggregates.bucket,
    summary_aggregates.group_value,
    NULL AS dimension,
    NULL AS facet_value,
    CAST(summary_aggregates.requests AS TEXT) AS requests_text,
    CAST(summary_aggregates.errors AS TEXT) AS errors_text,
    CAST(summary_aggregates.ttft_samples AS TEXT) AS ttft_samples_text,
    CAST(summary_aggregates.tpot_samples AS TEXT) AS tpot_samples_text,
    CAST(summary_aggregates.neutral AS TEXT) AS neutral_text,
    percentile_values.ttft_ms_p50,
    percentile_values.ttft_ms_p95,
    percentile_values.ttft_ms_p99,
    percentile_values.tpot_us_p50,
    percentile_values.tpot_us_p95,
    percentile_values.tpot_us_p99
  FROM summary_aggregates
  LEFT JOIN percentile_values USING (axis, bucket, group_value)
),
facet_rows AS (
  SELECT 'facet' AS row_kind, NULL AS axis, NULL AS bucket, NULL AS group_value,
    'keyId' AS dimension, key_id AS facet_value,
    NULL AS requests_text, NULL AS errors_text, NULL AS ttft_samples_text,
    NULL AS tpot_samples_text, NULL AS neutral_text,
    NULL AS ttft_ms_p50, NULL AS ttft_ms_p95, NULL AS ttft_ms_p99,
    NULL AS tpot_us_p50, NULL AS tpot_us_p95, NULL AS tpot_us_p99
  FROM scoped_summary
  WHERE owned = 1
  GROUP BY key_id
  UNION ALL
  SELECT 'facet', NULL, NULL, NULL, 'userId', CAST(user_id AS TEXT),
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
  FROM scoped_summary CROSS JOIN settings
  WHERE settings.is_admin = 1 AND user_id IS NOT NULL
  GROUP BY user_id
  UNION ALL
  SELECT 'facet', NULL, NULL, NULL, 'model', model,
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
  FROM scoped_summary GROUP BY model
  UNION ALL
  SELECT 'facet', NULL, NULL, NULL, 'upstream', upstream,
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
  FROM scoped_summary GROUP BY upstream
  UNION ALL
  SELECT 'facet', NULL, NULL, NULL, 'operation', operation,
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
  FROM scoped_summary GROUP BY operation
  UNION ALL
  SELECT 'facet', NULL, NULL, NULL, 'runtimeLocation', runtime_location,
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
  FROM scoped_summary GROUP BY runtime_location
),
orphan_rows AS (
  SELECT 'orphan' AS row_kind,
    NULL AS axis, NULL AS bucket, NULL AS group_value, NULL AS dimension, NULL AS facet_value,
    NULL AS requests_text, NULL AS errors_text, NULL AS ttft_samples_text,
    NULL AS tpot_samples_text, NULL AS neutral_text,
    NULL AS ttft_ms_p50, NULL AS ttft_ms_p95, NULL AS ttft_ms_p99,
    NULL AS tpot_us_p50, NULL AS tpot_us_p95, NULL AS tpot_us_p99
  FROM orphan_buckets
),
missing_hour_rows AS (
  SELECT 'missing_hour' AS row_kind,
    NULL AS axis, NULL AS bucket, NULL AS group_value, NULL AS dimension, hour AS facet_value,
    NULL AS requests_text, NULL AS errors_text, NULL AS ttft_samples_text,
    NULL AS tpot_samples_text, NULL AS neutral_text,
    NULL AS ttft_ms_p50, NULL AS ttft_ms_p95, NULL AS ttft_ms_p99,
    NULL AS tpot_us_p50, NULL AS tpot_us_p95, NULL AS tpot_us_p99
  FROM filtered_summary
  WHERE NOT EXISTS (SELECT 1 FROM bucket_map WHERE bucket_map.hour = filtered_summary.hour)
  GROUP BY hour
),
wire AS (
  SELECT * FROM facet_rows
  UNION ALL SELECT * FROM aggregate_rows
  UNION ALL SELECT * FROM orphan_rows
  UNION ALL SELECT * FROM missing_hour_rows
)
SELECT * FROM wire
ORDER BY row_kind, dimension, facet_value, axis, bucket, group_value`;

const safeInteger = (value: string | null, label: string): number => {
  if (value === null || !/^\d+$/.test(value)) {
    throw new TypeError(`${label} must be a non-negative integer: ${JSON.stringify(value)}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new RangeError(`${label} exceeds the safe integer range: ${value}`);
  return parsed;
};

const finishOverview = (rows: readonly PerformanceOverviewSqlRow[]): PerformanceOverviewResult => {
  const records = new Map<PerformanceOverviewAxis, PerformanceDisplayRecord[]>(
    [...overviewAxes].map(axis => [axis, []]),
  );
  const facets = new Map<string, Set<string>>(
    [...overviewDimensions].map(dimension => [dimension, new Set()]),
  );
  for (const row of rows) {
    if (row.row_kind === 'missing_hour') {
      throw new Error('Performance overview bucket map is incomplete');
    }
    if (row.row_kind === 'orphan') {
      throw new Error('performance_buckets row has no matching summary');
    }
    if (row.row_kind === 'facet') {
      if (row.dimension === null || row.facet_value === null || !overviewDimensions.has(row.dimension)) {
        throw new TypeError('Stored Performance overview returned an invalid facet row');
      }
      if (row.dimension === 'operation') parsePerformanceOperation(row.facet_value);
      facets.get(row.dimension)!.add(row.facet_value);
      continue;
    }
    if (row.axis === null || row.bucket === null || row.group_value === null || !overviewAxes.has(row.axis as PerformanceOverviewAxis)) {
      throw new TypeError('Stored Performance overview returned an invalid aggregate coordinate');
    }
    records.get(row.axis as PerformanceOverviewAxis)!.push({
      bucket: row.bucket,
      group: row.group_value,
      requests: safeInteger(row.requests_text, 'Performance overview requests'),
      errors: safeInteger(row.errors_text, 'Performance overview errors'),
      ttftSamples: safeInteger(row.ttft_samples_text, 'Performance overview TTFT samples'),
      tpotSamples: safeInteger(row.tpot_samples_text, 'Performance overview TPOT samples'),
      neutral: safeInteger(row.neutral_text, 'Performance overview neutral requests'),
      ttftMsP50: row.ttft_ms_p50,
      ttftMsP95: row.ttft_ms_p95,
      ttftMsP99: row.ttft_ms_p99,
      tpotUsP50: row.tpot_us_p50,
      tpotUsP95: row.tpot_us_p95,
      tpotUsP99: row.tpot_us_p99,
    });
  }
  for (const axisRecords of records.values()) {
    axisRecords.sort((left, right) => left.bucket.localeCompare(right.bucket) || left.group.localeCompare(right.group));
  }
  return {
    series: records.get('series')!,
    axes: {
      none: records.get('none')!,
      keyId: records.get('keyId')!,
      userId: records.get('userId')!,
      model: records.get('model')!,
      upstream: records.get('upstream')!,
      operation: records.get('operation')!,
      runtimeLocation: records.get('runtimeLocation')!,
    },
    dimensionValues: {
      keyIds: [...facets.get('keyId')!].sort(),
      userIds: [...facets.get('userId')!].map(Number).sort((left, right) => left - right),
      models: [...facets.get('model')!].sort(),
      upstreams: [...facets.get('upstream')!].sort(),
      operations: [...facets.get('operation')!].sort(),
      runtimeLocations: [...facets.get('runtimeLocation')!].sort(),
    },
  };
};

export const querySqlPerformanceOverview = async (
  db: SqlDatabase,
  opts: PerformanceOverviewQueryOptions,
): Promise<PerformanceOverviewResult> => {
  if (!opts.isAdmin && (opts.groupBy === 'userId' || opts.filters.userIds.length > 0)) {
    throw new Error('Performance user attribution requires administrator privileges');
  }
  const scoped = opts.groupBy === 'keyId';
  const range = rangeBinds(opts, scoped);
  const buckets: Record<string, string> = {};
  while (true) {
    const binds: SqlBindValue[] = [
      opts.actorUserId,
      opts.isAdmin ? 1 : 0,
      opts.groupBy,
      JSON.stringify(opts.filters.models),
      JSON.stringify(opts.filters.upstreams),
      JSON.stringify(opts.filters.operations),
      JSON.stringify(opts.filters.runtimeLocations),
      JSON.stringify(opts.filters.userIds),
      JSON.stringify(opts.filters.keyIds),
      JSON.stringify(buckets),
      ...range,
      ...range,
    ];
    const { results } = await db.prepare(overviewSql(scoped)).bind(...binds).all<PerformanceOverviewSqlRow>();
    const missingHours = results
      .filter(row => row.row_kind === 'missing_hour')
      .map(row => row.facet_value)
      .filter((hour): hour is string => hour !== null);
    if (missingHours.length === 0) return finishOverview(results);
    for (const hour of missingHours) {
      if (hour in buckets) throw new Error(`Performance overview did not accept bucket mapping for ${hour}`);
      buckets[hour] = opts.bucketForHour(hour);
    }
  }
};
