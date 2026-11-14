import type { UpstreamMetricRecord, UpstreamMetricsRepo } from './types.ts';
import type { SqlDatabase } from '@floway-dev/platform';
import { normalizeUpstreamMetricIdentity, type UpstreamMetricLabels } from '@floway-dev/provider';

export const UPSTREAM_METRICS_INTERVAL_MS = 60_000;
const columns = 'upstream_id AS upstreamId, metric_name AS name, metric_labels AS labelsJson, timestamp, value';
type SqlUpstreamMetricRecord = Omit<UpstreamMetricRecord, 'labels'> & { labelsJson: string };

const encodeIdentity = ({ name, labels }: UpstreamMetricRecord) => {
  const normalized = normalizeUpstreamMetricIdentity(name, labels);
  return { name: normalized.name, labelsJson: JSON.stringify(normalized.labels) };
};

const decodeRecords = (records: SqlUpstreamMetricRecord[]): UpstreamMetricRecord[] => records.map(({ labelsJson, ...record }) => ({
  ...record,
  ...normalizeUpstreamMetricIdentity(record.name, JSON.parse(labelsJson) as UpstreamMetricLabels),
}));

export class SqlUpstreamMetricsRepo implements UpstreamMetricsRepo {
  constructor(private db: SqlDatabase) {}

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
