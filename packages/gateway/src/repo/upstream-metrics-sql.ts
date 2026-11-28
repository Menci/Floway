import type { UpstreamMetricRecord, UpstreamMetricsRepo } from './types.ts';
import type { SqlDatabase } from '@floway-dev/platform';
import { normalizeUpstreamMetricIdentity, type UpstreamMetricIdentity, type UpstreamMetricLabels, type UpstreamMetricResetThreshold } from '@floway-dev/upstream';

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

  async listIdentities(upstreamId: string, before: number): Promise<UpstreamMetricIdentity[]> {
    const { results } = await this.db.prepare(`
      SELECT DISTINCT metric_name AS name, metric_labels AS labelsJson
      FROM upstream_metrics
      WHERE upstream_id = ? AND timestamp < ?
      ORDER BY metric_name, metric_labels
    `).bind(upstreamId, before).all<{ name: string; labelsJson: string }>();
    return results.map(({ name, labelsJson }) => normalizeUpstreamMetricIdentity(name, JSON.parse(labelsJson)));
  }

  async queryResetStarts(
    upstreamId: string, identity: UpstreamMetricIdentity, threshold: UpstreamMetricResetThreshold, before: number,
    { from = Number.MIN_SAFE_INTEGER, order = 'desc', limit = -1 }: NonNullable<Parameters<UpstreamMetricsRepo['queryResetStarts']>[4]> = {},
  ) {
    const metric = encodeIdentity(identity);
    const allowance = typeof threshold.full === 'number' ? null : encodeIdentity(threshold.full);
    const fullAt = (sample: 'sample' | 'previous') => allowance === null ? '?' : `(SELECT value FROM upstream_metrics allowance
      WHERE allowance.upstream_id = ${sample}.upstream_id AND allowance.metric_name = ? AND allowance.metric_labels = ?
        AND allowance.bucket = ${sample}.bucket AND allowance.timestamp = ${sample}.timestamp AND allowance.value > 0)`;
    const fullBindings = allowance === null ? [threshold.full as number] : [allowance.name, allowance.labelsJson];
    const depleted = threshold.direction === 'used' ? '>' : '<';
    const { results } = await this.db.prepare(`
      SELECT sample.timestamp, sample.value FROM upstream_metrics sample
      WHERE sample.upstream_id = ? AND sample.metric_name = ? AND sample.metric_labels = ?
        AND sample.timestamp >= ? AND sample.timestamp < ?
        AND sample.value = ${fullAt('sample')}
        AND EXISTS (
          SELECT 1 FROM upstream_metrics previous
          WHERE previous.upstream_id = sample.upstream_id AND previous.metric_name = sample.metric_name
            AND previous.metric_labels = sample.metric_labels
            AND previous.timestamp = (
              SELECT earlier.timestamp FROM upstream_metrics earlier
              WHERE earlier.upstream_id = sample.upstream_id AND earlier.metric_name = sample.metric_name
                AND earlier.metric_labels = sample.metric_labels AND earlier.timestamp < sample.timestamp
              ORDER BY earlier.timestamp DESC LIMIT 1
            )
            AND previous.value ${depleted} ${fullAt('previous')}
            ${allowance === null ? '' : 'AND sample.value > previous.value'}
        )
      ORDER BY sample.timestamp ${order === 'asc' ? 'ASC' : 'DESC'} LIMIT ?
    `).bind(upstreamId, metric.name, metric.labelsJson, from, before, ...fullBindings, ...fullBindings, limit).all<Pick<UpstreamMetricRecord, 'timestamp' | 'value'>>();
    return results;
  }
}
