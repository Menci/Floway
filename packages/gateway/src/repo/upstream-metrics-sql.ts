import type { UpstreamMetricRecord, UpstreamMetricsRepo } from './types.ts';
import type { SqlDatabase } from '@floway-dev/platform';
import { normalizeUpstreamMetricIdentity, type UpstreamMetricIdentity, type UpstreamMetricLabels } from '@floway-dev/provider';

export const UPSTREAM_METRICS_INTERVAL_MS = 60_000;
const columns = 'upstream_id AS upstreamId, metric_name AS name, metric_labels AS labelsJson, timestamp, value';
type SqlUpstreamMetricRecord = Omit<UpstreamMetricRecord, 'labels'> & { labelsJson: string };

const encodeIdentity = ({ name, labels }: UpstreamMetricIdentity) => {
  const normalized = normalizeUpstreamMetricIdentity(name, labels);
  return { name: normalized.name, labelsJson: JSON.stringify(normalized.labels) };
};

const decodeRecords = (records: SqlUpstreamMetricRecord[]): UpstreamMetricRecord[] => records.map(({ labelsJson, ...record }) => ({
  ...record,
  ...normalizeUpstreamMetricIdentity(record.name, JSON.parse(labelsJson) as UpstreamMetricLabels),
}));

export class SqlUpstreamMetricsRepo implements UpstreamMetricsRepo {
  constructor(private db: SqlDatabase) {}

  async listIdentities(upstreamId: string, end: number): Promise<UpstreamMetricIdentity[]> {
    const { results } = await this.db.prepare(`
      SELECT DISTINCT metric_name AS name, metric_labels AS labelsJson
      FROM upstream_metrics WHERE upstream_id = ? AND timestamp < ?
      ORDER BY metric_name, metric_labels
    `).bind(upstreamId, end).all<{ name: string; labelsJson: string }>();
    return results.map(({ name, labelsJson }) => normalizeUpstreamMetricIdentity(name, JSON.parse(labelsJson)));
  }

  async queryResetStarts(upstreamId: string, identity: UpstreamMetricIdentity, resetValue: number | UpstreamMetricIdentity, end: number): Promise<number[]> {
    const metric = encodeIdentity(identity);
    const allowance = typeof resetValue === 'number' ? null : encodeIdentity(resetValue);
    const full = allowance === null ? '?' : `(SELECT value FROM upstream_metrics allowance
      WHERE allowance.upstream_id = sample.upstream_id AND allowance.metric_name = ? AND allowance.metric_labels = ?
        AND allowance.bucket = sample.bucket AND allowance.timestamp = sample.timestamp AND allowance.value > 0)`;
    const bindings = allowance === null ? [resetValue as number] : [allowance.name, allowance.labelsJson];
    const { results } = await this.db.prepare(`
      WITH observations AS (
        SELECT timestamp, value, ${full} AS full_value FROM upstream_metrics sample
        WHERE upstream_id = ? AND metric_name = ? AND metric_labels = ? AND timestamp < ?
      ), transitions AS (
        SELECT timestamp, value, full_value,
          LAG(value) OVER (ORDER BY timestamp) AS previous_value,
          LAG(full_value) OVER (ORDER BY timestamp) AS previous_full_value
        FROM observations
      )
      SELECT timestamp FROM transitions
      WHERE value = full_value AND previous_value <> previous_full_value
      ORDER BY timestamp DESC LIMIT 2
    `).bind(...bindings, upstreamId, metric.name, metric.labelsJson, end).all<{ timestamp: number }>();
    return results.map(record => record.timestamp);
  }

  async record(record: UpstreamMetricRecord): Promise<void> {
    const identity = encodeIdentity(record);
    // Every observation is a gauge sample, unchanged values included: a sample
    // records that the value was observed, which a change log cannot express.
    // Each bucket keeps its latest sample, so a delayed observation can still
    // fill an older minute without replacing a newer sample from that minute.
    await this.db.prepare(`
      INSERT INTO upstream_metrics (upstream_id, metric_name, metric_labels, bucket, timestamp, value)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (upstream_id, metric_name, metric_labels, bucket) DO UPDATE SET
        timestamp = excluded.timestamp, value = excluded.value
      WHERE excluded.timestamp >= upstream_metrics.timestamp
    `).bind(record.upstreamId, identity.name, identity.labelsJson, Math.floor(record.timestamp / UPSTREAM_METRICS_INTERVAL_MS), record.timestamp, record.value).run();
  }

  async listAll(): Promise<UpstreamMetricRecord[]> {
    const { results } = await this.db.prepare(`SELECT ${columns} FROM upstream_metrics ORDER BY timestamp, upstreamId, name, labelsJson`).all<SqlUpstreamMetricRecord>();
    return decodeRecords(results);
  }

  async set(record: UpstreamMetricRecord): Promise<void> {
    const identity = encodeIdentity(record);
    await this.db.prepare(`
      INSERT INTO upstream_metrics (upstream_id, metric_name, metric_labels, bucket, timestamp, value)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (upstream_id, metric_name, metric_labels, bucket) DO UPDATE SET
        timestamp = excluded.timestamp, value = excluded.value
    `).bind(record.upstreamId, identity.name, identity.labelsJson, Math.floor(record.timestamp / UPSTREAM_METRICS_INTERVAL_MS), record.timestamp, record.value).run();
  }

  async deleteAll(): Promise<void> {
    await this.db.prepare('DELETE FROM upstream_metrics').run();
  }

  async query(upstreamId: string, start: number, end: number, step: number): Promise<UpstreamMetricRecord[]> {
    const { results } = await this.db.prepare(`
      SELECT upstreamId, name, labelsJson, timestamp, value FROM (
        SELECT ${columns}, ROW_NUMBER() OVER (
          PARTITION BY metric_name, metric_labels, CAST((timestamp - ?) / ? AS INTEGER) ORDER BY timestamp DESC
        ) AS recency
        FROM upstream_metrics
        WHERE timestamp >= ? AND timestamp < ? AND upstream_id = ?
      )
      WHERE recency = 1
      ORDER BY timestamp, upstreamId, name, labelsJson
    `).bind(start, step, start, end, upstreamId).all<SqlUpstreamMetricRecord>();
    return decodeRecords(results);
  }
}
