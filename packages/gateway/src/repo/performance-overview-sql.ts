import type {
  PerformanceDisplayRecord,
  PerformanceOverviewAxis,
  PerformanceOverviewQueryOptions,
  PerformanceOverviewResult,
} from './types.ts';
import type { SqlBindValue, SqlDatabase } from '@floway-dev/platform';
import { parsePerformanceOperation } from '@floway-dev/provider';

interface PerformanceOverviewSqlRow {
  row_kind: 'aggregate' | 'facet' | 'invalid_histogram' | 'missing_hour' | 'orphan';
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

const overviewHoursSql = (scoped: boolean) => `/* performance-overview-hours */
  SELECT performance_summary.hour AS hour
  FROM performance_summary
  WHERE ${scopedRange('performance_summary', scoped)}
  GROUP BY performance_summary.hour
  ORDER BY performance_summary.hour`;

const overviewGroupingSql = "CASE WHEN axes.axis = 'series' THEN settings.series_group_by ELSE axes.axis END";
const overviewGroupSql = (source: string, grouping = overviewGroupingSql) => `CASE ${grouping}
  WHEN 'none' THEN 'all'
  WHEN 'keyId' THEN ${source}.key_id
  WHEN 'userId' THEN CAST(${source}.user_id AS TEXT)
  WHEN 'model' THEN ${source}.model
  WHEN 'upstream' THEN ${source}.upstream
  WHEN 'operation' THEN ${source}.operation
  WHEN 'runtimeLocation' THEN ${source}.runtime_location
END`;
const overviewWhereSql = (source: string) => `(axes.owned_only = 0 OR ${source}.owned = 1)
    AND (${overviewGroupingSql} != 'userId' OR ${source}.user_id IS NOT NULL)`;

const summaryAggregateSql = `
  SELECT
    axes.axis,
    CASE WHEN axes.axis = 'series' THEN summary_cube.time_bucket ELSE 'all' END AS bucket,
    ${overviewGroupSql('summary_cube')} AS group_value,
    SUM(summary_cube.requests) AS requests,
    SUM(summary_cube.errors_with_output) + SUM(summary_cube.errors_no_output) AS errors,
    SUM(summary_cube.ttft_samples_ok) + SUM(summary_cube.errors_with_output) AS ttft_samples,
    SUM(summary_cube.tpot_samples) AS tpot_samples,
    SUM(summary_cube.neutral) AS neutral
  FROM summary_cube
  CROSS JOIN axes
  CROSS JOIN settings
  WHERE ${overviewWhereSql('summary_cube')}
  GROUP BY axes.axis, bucket, group_value`;

const histogramAggregateSql = `
  SELECT
    axes.axis,
    CASE WHEN axes.axis = 'series' THEN histogram_cube.time_bucket ELSE 'all' END AS bucket,
    ${overviewGroupSql('histogram_cube')} AS group_value,
    histogram_cube.metric,
    histogram_cube.lower,
    MAX(histogram_cube.upper) AS upper,
    SUM(histogram_cube.count) AS count
  FROM histogram_cube
  CROSS JOIN axes
  CROSS JOIN settings
  WHERE ${overviewWhereSql('histogram_cube')}
  GROUP BY axes.axis, bucket, group_value, histogram_cube.metric, histogram_cube.lower`;

const facetRowsSql = `SELECT 'facet' AS row_kind, NULL AS axis, NULL AS bucket, NULL AS group_value,
    axes.axis AS dimension, ${overviewGroupSql('authorized_summary', 'axes.axis')} AS facet_value,
    NULL AS requests_text, NULL AS errors_text, NULL AS ttft_samples_text,
    NULL AS tpot_samples_text, NULL AS neutral_text,
    NULL AS ttft_ms_p50, NULL AS ttft_ms_p95, NULL AS ttft_ms_p99,
    NULL AS tpot_us_p50, NULL AS tpot_us_p95, NULL AS tpot_us_p99
  FROM authorized_summary
  CROSS JOIN axes
  WHERE axes.axis NOT IN ('none', 'series')
    AND (axes.owned_only = 0 OR authorized_summary.owned = 1)
    AND (axes.axis != 'userId' OR authorized_summary.user_id IS NOT NULL)
  GROUP BY dimension, facet_value`;

const performanceCubeDimensions = [
  'key_id', 'user_id', 'owned', 'model', 'upstream', 'operation', 'runtime_location',
] as const;
const performanceCubeCoordinateSql = performanceCubeDimensions.join(', ');

// CTE references expand before materialization; one cube scan across axis rows
// keeps adding dimensions from copying the entire filtered source tree.
// https://github.com/sqlite/sqlite/blob/version-3.54.1/src/select.c#L5672-L5682
const overviewSql = (scoped: boolean) => `/* performance-overview */
WITH
settings(
  actor_user_id, is_admin, series_group_by,
  models_json, upstreams_json, operations_json, runtimes_json,
  users_json, keys_json, visible_users_json, visible_upstreams_json
) AS (
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
),
axes(axis, owned_only) AS (
  VALUES ${[...overviewAxes].map(axis => `('${axis}', ${axis === 'keyId' ? 1 : 0})`).join(', ')}
),
bucket_map(hour, bucket) AS MATERIALIZED (
  SELECT key, CAST(value AS TEXT) FROM json_each(?)
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
authorized_summary AS MATERIALIZED (
  SELECT
    performance_summary.*,
    api_keys.user_id,
    CASE WHEN api_keys.user_id = settings.actor_user_id THEN 1 ELSE 0 END AS owned
  FROM performance_summary
  CROSS JOIN settings
  LEFT JOIN api_keys ON api_keys.id = performance_summary.key_id
  WHERE ${scoped ? 'api_keys.user_id = ? AND performance_summary.hour >= ? AND performance_summary.hour < ?' : scopedRange('performance_summary', false)}
    AND (
      settings.is_admin = 1
      OR api_keys.user_id IN (SELECT CAST(value AS INTEGER) FROM json_each(settings.visible_users_json))
      OR performance_summary.upstream IN (SELECT CAST(value AS TEXT) FROM json_each(settings.visible_upstreams_json))
    )
),
filtered_summary AS MATERIALIZED (
  SELECT authorized_summary.*
  FROM authorized_summary
  CROSS JOIN settings
  WHERE
    (json_array_length(settings.models_json) = 0 OR model IN (SELECT CAST(value AS TEXT) FROM json_each(settings.models_json)))
    AND (json_array_length(settings.upstreams_json) = 0 OR upstream IN (SELECT CAST(value AS TEXT) FROM json_each(settings.upstreams_json)))
    AND (json_array_length(settings.operations_json) = 0 OR operation IN (SELECT CAST(value AS TEXT) FROM json_each(settings.operations_json)))
    AND (json_array_length(settings.runtimes_json) = 0 OR runtime_location IN (SELECT CAST(value AS TEXT) FROM json_each(settings.runtimes_json)))
    AND (json_array_length(settings.users_json) = 0 OR user_id IN (SELECT CAST(value AS INTEGER) FROM json_each(settings.users_json)))
    AND (json_array_length(settings.keys_json) = 0 OR key_id IN (SELECT CAST(value AS TEXT) FROM json_each(settings.keys_json)))
),
filtered_histogram AS MATERIALIZED (
  SELECT
    filtered_summary.*,
    performance_buckets.metric,
    performance_buckets.lower,
    performance_buckets.upper,
    performance_buckets.count
  FROM filtered_summary
  JOIN performance_buckets ON
    performance_buckets.hour = filtered_summary.hour
    AND performance_buckets.key_id = filtered_summary.key_id
    AND performance_buckets.model = filtered_summary.model
    AND performance_buckets.upstream = filtered_summary.upstream
    AND performance_buckets.operation = filtered_summary.operation
    AND performance_buckets.runtime_location = filtered_summary.runtime_location
),
summary_cube AS MATERIALIZED (
  SELECT
    bucket_map.bucket AS time_bucket,
    ${performanceCubeCoordinateSql},
    SUM(requests) AS requests,
    SUM(ttft_samples_ok) AS ttft_samples_ok,
    SUM(errors_with_output) AS errors_with_output,
    SUM(errors_no_output) AS errors_no_output,
    SUM(neutral) AS neutral,
    SUM(tpot_samples) AS tpot_samples
  FROM filtered_summary
  JOIN bucket_map ON bucket_map.hour = filtered_summary.hour
  GROUP BY bucket_map.bucket, ${performanceCubeCoordinateSql}
),
histogram_cube AS MATERIALIZED (
  SELECT
    bucket_map.bucket AS time_bucket,
    ${performanceCubeCoordinateSql},
    metric, lower, MAX(upper) AS upper, SUM(count) AS count
  FROM filtered_histogram
  JOIN bucket_map ON bucket_map.hour = filtered_histogram.hour
  GROUP BY bucket_map.bucket, ${performanceCubeCoordinateSql}, metric, lower
),
summary_aggregates AS MATERIALIZED (
  ${summaryAggregateSql}
),
invalid_histogram_bounds AS MATERIALIZED (
  SELECT 1 AS present
  FROM filtered_histogram
  GROUP BY metric, lower
  HAVING COUNT(DISTINCT COALESCE(CAST(upper AS TEXT), 'null')) > 1
  LIMIT 1
),
histogram AS MATERIALIZED (
  ${histogramAggregateSql}
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
)
${facetRowsSql}
UNION ALL
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
UNION ALL
  SELECT 'orphan' AS row_kind,
    NULL AS axis, NULL AS bucket, NULL AS group_value, NULL AS dimension, NULL AS facet_value,
    NULL AS requests_text, NULL AS errors_text, NULL AS ttft_samples_text,
    NULL AS tpot_samples_text, NULL AS neutral_text,
    NULL AS ttft_ms_p50, NULL AS ttft_ms_p95, NULL AS ttft_ms_p99,
    NULL AS tpot_us_p50, NULL AS tpot_us_p95, NULL AS tpot_us_p99
  FROM orphan_buckets
UNION ALL
  SELECT 'invalid_histogram' AS row_kind,
    NULL AS axis, NULL AS bucket, NULL AS group_value, NULL AS dimension, NULL AS facet_value,
    NULL AS requests_text, NULL AS errors_text, NULL AS ttft_samples_text,
    NULL AS tpot_samples_text, NULL AS neutral_text,
    NULL AS ttft_ms_p50, NULL AS ttft_ms_p95, NULL AS ttft_ms_p99,
    NULL AS tpot_us_p50, NULL AS tpot_us_p95, NULL AS tpot_us_p99
  FROM invalid_histogram_bounds
UNION ALL
  SELECT 'missing_hour' AS row_kind,
    NULL AS axis, NULL AS bucket, NULL AS group_value, NULL AS dimension, hour AS facet_value,
    NULL AS requests_text, NULL AS errors_text, NULL AS ttft_samples_text,
    NULL AS tpot_samples_text, NULL AS neutral_text,
    NULL AS ttft_ms_p50, NULL AS ttft_ms_p95, NULL AS ttft_ms_p99,
    NULL AS tpot_us_p50, NULL AS tpot_us_p95, NULL AS tpot_us_p99
  FROM filtered_summary
  WHERE NOT EXISTS (SELECT 1 FROM bucket_map WHERE bucket_map.hour = filtered_summary.hour)
  GROUP BY hour
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
    if (row.row_kind === 'invalid_histogram') {
      throw new Error('performance_buckets rows disagree on histogram bounds');
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
  const scoped = opts.groupBy === 'keyId';
  const range = rangeBinds(opts, scoped);
  const { results: hours } = await db.prepare(overviewHoursSql(scoped))
    .bind(...range)
    .all<{ hour: string }>();
  const buckets = Object.fromEntries(hours.map(({ hour }) => [hour, opts.bucketForHour(hour)]));
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
      JSON.stringify(opts.visibleUserIds),
      JSON.stringify(opts.visibleUpstreams),
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
