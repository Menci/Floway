import type { UpstreamUsageMetricRecord, UpstreamUsageMetricsRepo } from './types.ts';
import type { SqlDatabase } from '@floway-dev/platform';

export const UPSTREAM_USAGE_INTERVAL_MS = 60_000;
const columns = 'upstream_id AS upstreamId, metric_key AS key, timestamp, value, provider, upstream_name AS upstreamName, upstream_hue AS upstreamHue';

export class SqlUpstreamUsageMetricsRepo implements UpstreamUsageMetricsRepo {
  constructor(private db: SqlDatabase) {}

  async record(record: UpstreamUsageMetricRecord): Promise<void> {
    // Coalesce in SQL so concurrent requests and separate Worker isolates retain
    // the latest observation in each interval without relying on process timers.
    await this.db.prepare(`
      INSERT INTO upstream_usage_metrics (upstream_id, metric_key, bucket, timestamp, value, provider, upstream_name, upstream_hue)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM upstream_usage_metrics
        WHERE upstream_id = ? AND metric_key = ? AND timestamp > ?
      ) AND NOT EXISTS (
        SELECT 1 FROM upstream_usage_metrics
        WHERE upstream_id = ? AND metric_key = ? AND value = ?
          AND timestamp = (SELECT MAX(timestamp) FROM upstream_usage_metrics WHERE upstream_id = ? AND metric_key = ?)
      )
      ON CONFLICT (upstream_id, metric_key, bucket) DO UPDATE SET
        timestamp = excluded.timestamp, value = excluded.value, provider = excluded.provider,
        upstream_name = excluded.upstream_name, upstream_hue = excluded.upstream_hue
      WHERE excluded.timestamp >= upstream_usage_metrics.timestamp
    `).bind(record.upstreamId, record.key, Math.floor(record.timestamp / UPSTREAM_USAGE_INTERVAL_MS), record.timestamp, record.value, record.provider, record.upstreamName, record.upstreamHue,
      record.upstreamId, record.key, record.timestamp, record.upstreamId, record.key, record.value, record.upstreamId, record.key).run();
  }

  async query(start: number, end: number): Promise<UpstreamUsageMetricRecord[]> {
    // A gauge persists until its next observation, including at the left edge of a query.
    const { results } = await this.db.prepare(`
      SELECT ${columns} FROM upstream_usage_metrics
      WHERE timestamp >= ? AND timestamp < ?
      UNION ALL
      SELECT ${columns} FROM upstream_usage_metrics
      WHERE (upstream_id, metric_key, timestamp) IN (
        SELECT upstream_id, metric_key, MAX(timestamp) FROM upstream_usage_metrics
        WHERE timestamp < ? GROUP BY upstream_id, metric_key
      )
      ORDER BY timestamp, upstreamId, key
    `).bind(start, end, start).all<UpstreamUsageMetricRecord>();
    return results;
  }
}
