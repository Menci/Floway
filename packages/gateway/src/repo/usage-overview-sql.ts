import type {
  UsageOverviewAxis,
  UsageOverviewQueryOptions,
  UsageOverviewRecord,
  UsageOverviewResult,
} from './types.ts';
import type { SqlBindValue, SqlDatabase } from '@floway-dev/platform';
import {
  addDecimalStrings,
  multiplyDecimalStrings,
  parseBillingMetric,
  parseNonNegativeDecimalString,
  type BillingMetric,
  type DecimalString,
} from '@floway-dev/protocols/common';

interface UsageOverviewSqlRow {
  row_kind: 'facet' | 'metric' | 'request';
  axis: string | null;
  bucket: string | null;
  group_value: string | null;
  dimension: string | null;
  facet_value: string | null;
  requests_text: string | null;
  metric: string | null;
  quantity: string | null;
  unit_price: string | null;
  occurrences_text: string | null;
  metric_order: number | null;
}

const overviewAxes = new Set<UsageOverviewAxis>(['series', 'none', 'keyId', 'userId', 'model', 'upstream']);
const overviewDimensions = new Set(['keyId', 'userId', 'model', 'upstream']);

const scopedRange = (table: string, scoped: boolean) => scoped
  ? `${table}.key_id IN (SELECT id FROM api_keys WHERE user_id = ?) AND ${table}.hour >= ? AND ${table}.hour < ?`
  : `${table}.hour >= ? AND ${table}.hour < ?`;

const rangeBinds = (opts: UsageOverviewQueryOptions, scoped: boolean): SqlBindValue[] => scoped
  ? [opts.actorUserId, opts.start, opts.end]
  : [opts.start, opts.end];

const overviewHoursSql = (scoped: boolean) => `/* usage-overview-hours */
  SELECT hour FROM (
    SELECT usage_requests.hour AS hour
    FROM usage_requests
    WHERE ${scopedRange('usage_requests', scoped)}
    UNION ALL
    SELECT usage.hour AS hour
    FROM usage
    WHERE ${scopedRange('usage', scoped)}
  )
  GROUP BY hour
  ORDER BY hour`;

const overviewSql = (scoped: boolean) => `/* usage-overview */
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
user_filter(value) AS MATERIALIZED (
  SELECT CAST(value AS INTEGER) FROM json_each(?)
),
key_filter(value) AS MATERIALIZED (
  SELECT CAST(value AS TEXT) FROM json_each(?)
),
bucket_map(hour, bucket) AS MATERIALIZED (
  SELECT key, CAST(value AS TEXT) FROM json_each(?)
),
facts AS MATERIALIZED (
  SELECT
    'request' AS fact_kind,
    usage_requests.rowid AS source_order,
    usage_requests.key_id,
    usage_requests.model,
    usage_requests.upstream,
    usage_requests.hour,
    usage_requests.requests,
    NULL AS metric,
    NULL AS quantity,
    NULL AS unit_price
  FROM usage_requests
  WHERE ${scopedRange('usage_requests', scoped)}
  UNION ALL
  SELECT
    'metric' AS fact_kind,
    usage.rowid AS source_order,
    usage.key_id,
    usage.model,
    usage.upstream,
    usage.hour,
    0 AS requests,
    usage.metric,
    usage.quantity,
    usage.unit_price
  FROM usage
  WHERE ${scopedRange('usage', scoped)}
),
scoped AS MATERIALIZED (
  SELECT
    facts.*,
    COALESCE(api_keys.user_id, 0) AS user_id,
    CASE WHEN api_keys.user_id = settings.actor_user_id THEN 1 ELSE 0 END AS owned,
    CASE WHEN facts.upstream IS NULL THEN 'none' ELSE 'upstream:' || facts.upstream END AS upstream_value
  FROM facts
  CROSS JOIN settings
  LEFT JOIN api_keys ON api_keys.id = facts.key_id
),
filtered AS MATERIALIZED (
  SELECT *
  FROM scoped
  WHERE
    (NOT EXISTS (SELECT 1 FROM model_filter) OR model IN (SELECT value FROM model_filter))
    AND (NOT EXISTS (SELECT 1 FROM upstream_filter) OR upstream_value IN (SELECT value FROM upstream_filter))
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
),
projected AS MATERIALIZED (
  SELECT
    filtered.*,
    axes.axis,
    CASE WHEN axes.bucketed = 1 THEN bucket_map.bucket ELSE 'all' END AS bucket,
    CASE axes.grouping
      WHEN 'none' THEN 'all'
      WHEN 'keyId' THEN filtered.key_id
      WHEN 'userId' THEN CAST(filtered.user_id AS TEXT)
      WHEN 'model' THEN filtered.model
      WHEN 'upstream' THEN filtered.upstream_value
    END AS group_value
  FROM filtered
  CROSS JOIN axes
  CROSS JOIN settings
  JOIN bucket_map ON bucket_map.hour = filtered.hour
  WHERE (axes.owned_only = 0 OR filtered.owned = 1)
    AND (axes.admin_only = 0 OR settings.is_admin = 1)
),
facet_rows AS (
  SELECT 'facet' AS row_kind, NULL AS axis, NULL AS bucket, NULL AS group_value,
    'keyId' AS dimension, key_id AS facet_value, NULL AS requests_text,
    NULL AS metric, NULL AS quantity, NULL AS unit_price, NULL AS occurrences_text, NULL AS metric_order
  FROM scoped
  WHERE owned = 1
  GROUP BY key_id
  UNION ALL
  SELECT 'facet', NULL, NULL, NULL, 'userId', CAST(user_id AS TEXT), NULL, NULL, NULL, NULL, NULL, NULL
  FROM scoped CROSS JOIN settings
  WHERE settings.is_admin = 1
  GROUP BY user_id
  UNION ALL
  SELECT 'facet', NULL, NULL, NULL, 'model', model, NULL, NULL, NULL, NULL, NULL, NULL
  FROM scoped
  GROUP BY model
  UNION ALL
  SELECT 'facet', NULL, NULL, NULL, 'upstream', upstream_value, NULL, NULL, NULL, NULL, NULL, NULL
  FROM scoped
  GROUP BY upstream_value
),
request_rows AS (
  SELECT 'request' AS row_kind, axis, bucket, group_value, NULL AS dimension, NULL AS facet_value,
    CAST(SUM(requests) AS TEXT) AS requests_text,
    NULL AS metric, NULL AS quantity, NULL AS unit_price, NULL AS occurrences_text, NULL AS metric_order
  FROM projected
  WHERE fact_kind = 'request'
  GROUP BY axis, bucket, group_value
),
metric_rows AS (
  SELECT 'metric' AS row_kind, axis, bucket, group_value, NULL AS dimension, NULL AS facet_value,
    NULL AS requests_text, metric, quantity, unit_price,
    CAST(COUNT(*) AS TEXT) AS occurrences_text,
    MIN(source_order) AS metric_order
  FROM projected
  WHERE fact_kind = 'metric'
  GROUP BY axis, bucket, group_value, metric, quantity, unit_price
),
wire AS (
  SELECT * FROM facet_rows
  UNION ALL SELECT * FROM request_rows
  UNION ALL SELECT * FROM metric_rows
)
SELECT * FROM wire
ORDER BY row_kind, dimension, facet_value, axis, bucket, group_value, metric_order, metric, unit_price, quantity`;

const safeInteger = (value: string, label: string): number => {
  if (!/^\d+$/.test(value)) throw new TypeError(`${label} must be a non-negative integer: ${JSON.stringify(value)}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new RangeError(`${label} exceeds the safe integer range: ${value}`);
  return parsed;
};

interface MutableOverviewRecord extends Omit<UsageOverviewRecord, 'metrics'> {
  metrics: Map<BillingMetric, { quantity: DecimalString; order: number }>;
}

const finishOverview = (rows: readonly UsageOverviewSqlRow[]): UsageOverviewResult => {
  const records = new Map<UsageOverviewAxis, Map<string, MutableOverviewRecord>>(
    [...overviewAxes].map(axis => [axis, new Map()]),
  );
  const facets = new Map<string, Set<string>>(
    [...overviewDimensions].map(dimension => [dimension, new Set()]),
  );
  const ensureRecord = (axis: UsageOverviewAxis, bucket: string, group: string) => {
    const key = `${bucket}\0${group}`;
    const axisRecords = records.get(axis)!;
    let record = axisRecords.get(key);
    if (!record) {
      record = { bucket, group, requests: 0, metrics: new Map(), cost: null };
      axisRecords.set(key, record);
    }
    return record;
  };

  for (const row of rows) {
    if (row.row_kind === 'facet') {
      if (row.dimension === null || row.facet_value === null || !overviewDimensions.has(row.dimension)) {
        throw new TypeError('Stored Usage overview returned an invalid facet row');
      }
      facets.get(row.dimension)!.add(row.facet_value);
      continue;
    }
    if (row.axis === null || row.bucket === null || row.group_value === null || !overviewAxes.has(row.axis as UsageOverviewAxis)) {
      throw new TypeError('Stored Usage overview returned an invalid aggregate coordinate');
    }
    const aggregate = ensureRecord(row.axis as UsageOverviewAxis, row.bucket, row.group_value);
    if (row.row_kind === 'request') {
      if (row.requests_text === null) throw new TypeError('Stored Usage overview request row omitted requests');
      aggregate.requests = safeInteger(row.requests_text, 'Usage overview requests');
      continue;
    }
    if (row.metric === null || row.quantity === null || row.occurrences_text === null || row.metric_order === null) {
      throw new TypeError('Stored Usage overview metric row is incomplete');
    }
    const metric = parseBillingMetric(row.metric, 'usage.metric');
    const quantity = parseNonNegativeDecimalString(row.quantity, `usage metric ${metric} quantity`);
    const unitPrice = row.unit_price === null
      ? null
      : parseNonNegativeDecimalString(row.unit_price, `usage metric ${metric} unit price`);
    if (quantity !== row.quantity) throw new TypeError(`Stored usage metric ${metric} quantity must be canonical: ${JSON.stringify(row.quantity)}`);
    if (unitPrice !== row.unit_price) throw new TypeError(`Stored usage metric ${metric} unit price must be canonical: ${JSON.stringify(row.unit_price)}`);
    const occurrences = safeInteger(row.occurrences_text, 'Usage overview metric occurrence count');
    const contribution = multiplyDecimalStrings(quantity, String(occurrences));
    const existing = aggregate.metrics.get(metric);
    aggregate.metrics.set(metric, existing
      ? { quantity: addDecimalStrings(existing.quantity, contribution), order: Math.min(existing.order, row.metric_order) }
      : { quantity: contribution, order: row.metric_order });
    if (unitPrice !== null) {
      aggregate.cost = addDecimalStrings(
        aggregate.cost ?? '0',
        multiplyDecimalStrings(contribution, unitPrice),
      );
    }
  }

  const finished = (axis: UsageOverviewAxis): UsageOverviewRecord[] => [...records.get(axis)!.values()]
    .map(record => ({
      bucket: record.bucket,
      group: record.group,
      requests: record.requests,
      metrics: [...record.metrics.entries()]
        .sort((left, right) => left[1].order - right[1].order || left[0].localeCompare(right[0]))
        .map(([metric, value]) => ({ metric, quantity: value.quantity })),
      cost: record.cost,
    }))
    .sort((left, right) => left.bucket.localeCompare(right.bucket) || left.group.localeCompare(right.group));

  return {
    series: finished('series'),
    axes: {
      none: finished('none'),
      keyId: finished('keyId'),
      userId: finished('userId'),
      model: finished('model'),
      upstream: finished('upstream'),
    },
    dimensionValues: {
      keyIds: [...facets.get('keyId')!].sort(),
      userIds: [...facets.get('userId')!].map(Number).sort((left, right) => left - right),
      models: [...facets.get('model')!].sort(),
      upstreams: [...facets.get('upstream')!].sort(),
    },
  };
};

export const querySqlUsageOverview = async (
  db: SqlDatabase,
  opts: UsageOverviewQueryOptions,
): Promise<UsageOverviewResult> => {
  const scoped = !opts.isAdmin || opts.groupBy === 'keyId';
  const range = rangeBinds(opts, scoped);
  const { results: hours } = await db.prepare(overviewHoursSql(scoped))
    .bind(...range, ...range)
    .all<{ hour: string }>();
  const buckets = Object.fromEntries(hours.map(({ hour }) => [hour, opts.bucketForHour(hour)]));
  const binds: SqlBindValue[] = [
    opts.actorUserId,
    opts.isAdmin ? 1 : 0,
    opts.groupBy,
    JSON.stringify(opts.filters.models),
    JSON.stringify(opts.filters.upstreams),
    JSON.stringify(opts.filters.userIds),
    JSON.stringify(opts.filters.keyIds),
    JSON.stringify(buckets),
    ...range,
    ...range,
  ];
  const { results } = await db.prepare(overviewSql(scoped)).bind(...binds).all<UsageOverviewSqlRow>();
  return finishOverview(results);
};
