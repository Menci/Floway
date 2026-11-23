import { DUMP_FILE_PREFIX, SPILLED_FILE_STAGE_GRACE_MS } from './spilled-files-policy.ts';
import { parseUpstreamHue, parseUpstreamKind } from './upstream-parse.ts';
import { decodePersistedDumpMetadata, encodePersistedDumpMetadata } from '../dump/storage-codec.ts';
import type { DumpListOptions, DumpStore } from '../dump/store-contract.ts';
import type { DumpMetadata, DumpRecordId, DumpUpstreamRef } from '../dump/types.ts';
import { gunzipStream, gzipStream } from '../shared/gzip.ts';
import type { FileStore, SqlDatabase } from '@floway-dev/platform';

const HOUR_MS = 60 * 60 * 1000;

interface DumpRow {
  id: string;
  artifact_key: string;
  upstream_id: string | null;
  upstream_name: string | null;
  upstream_kind: string | null;
  upstream_hue: number | null;
  meta_json: string;
}

type DumpMetadataRow = Pick<DumpRow, 'id' | 'upstream_id' | 'upstream_name' | 'upstream_kind' | 'upstream_hue' | 'meta_json'>;

const hydrateUpstream = (row: Pick<DumpRow, 'upstream_id' | 'upstream_name' | 'upstream_kind' | 'upstream_hue'>): DumpUpstreamRef | null => {
  if (row.upstream_id === null || row.upstream_name === null) return null;
  return {
    id: row.upstream_id,
    name: row.upstream_name,
    kind: parseUpstreamKind(row.upstream_id, row.upstream_kind),
    hue: parseUpstreamHue(row.upstream_id, row.upstream_hue),
  };
};

const hourBucket = (ms: number): string => {
  const date = new Date(Math.floor(ms / HOUR_MS) * HOUR_MS);
  const y = date.getUTCFullYear().toString().padStart(4, '0');
  const m = (date.getUTCMonth() + 1).toString().padStart(2, '0');
  const d = date.getUTCDate().toString().padStart(2, '0');
  const h = date.getUTCHours().toString().padStart(2, '0');
  return `${y}${m}${d}${h}`;
};

const metadataFromRow = (row: DumpMetadataRow): DumpMetadata => ({
  ...decodePersistedDumpMetadata(row.meta_json, `dump record ${row.id} metadata`),
  upstream: hydrateUpstream(row),
});

export class FileDumpStore implements DumpStore {
  constructor(private readonly db: SqlDatabase, private readonly files: FileStore) {}

  createArtifactKey(keyId: string, startedAt: number, recordId: string): string {
    return `${DUMP_FILE_PREFIX}${keyId}/${hourBucket(startedAt)}/${recordId}-${crypto.randomUUID()}.ndjson.gz`;
  }

  async stageAndPutArtifact(
    keyId: string,
    recordId: string,
    artifactKey: string,
    ndjsonStream: ReadableStream<Uint8Array>,
  ): Promise<void> {
    await this.db.prepare(
      `INSERT INTO spilled_files (file_key, owner_kind, owner_key, state, collect_after)
       VALUES (?, 'dump-artifact', json_array(?, ?), 'staged', ?)`,
    ).bind(artifactKey, keyId, recordId, Date.now() + SPILLED_FILE_STAGE_GRACE_MS).run();
    await this.files.put(artifactKey, gzipStream(ndjsonStream));
  }

  async commitRecord(
    keyId: string,
    record: { readonly meta: DumpMetadata; readonly artifactKey: string },
  ): Promise<void> {
    await this.db.prepare(
      `UPDATE spilled_files
       SET collect_after = ?
       WHERE file_key = ? AND state = 'staged' AND claim_token IS NULL`,
    ).bind(Date.now() + SPILLED_FILE_STAGE_GRACE_MS, record.artifactKey).run();
    await this.db.prepare(
      `INSERT INTO dump_records (key_id, id, created_at, upstream_id, meta_json, artifact_key)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      keyId,
      record.meta.id,
      record.meta.completedAt,
      record.meta.upstream?.id ?? null,
      encodePersistedDumpMetadata(record.meta, `dump record ${record.meta.id} metadata`),
      record.artifactKey,
    ).run();
  }

  async list(keyId: string, opts: DumpListOptions): Promise<DumpMetadata[]> {
    const beforeId = opts.before ?? null;
    const beforeRow = beforeId === null
      ? null
      : await this.db.prepare(
          'SELECT created_at FROM dump_records WHERE key_id = ? AND id = ?',
        ).bind(keyId, beforeId).first<{ created_at: number }>();
    if (beforeId !== null && beforeRow === null) return [];
    const beforeTs = beforeRow?.created_at ?? null;

    const select
      = 'SELECT d.id, d.meta_json, d.upstream_id, u.name AS upstream_name, u.provider AS upstream_kind, u.hue AS upstream_hue '
      + 'FROM dump_records d LEFT JOIN upstreams u ON u.id = d.upstream_id '
      + 'JOIN api_keys k ON k.id = d.key_id AND k.deleted_at IS NULL AND k.dump_retention_seconds IS NOT NULL ';
    const conditions = ['d.key_id = ?', 'd.created_at >= ? - k.dump_retention_seconds * 1000'];
    const parameters: (string | number)[] = [keyId, Date.now()];
    if (beforeTs !== null) {
      conditions.push('(d.created_at < ? OR (d.created_at = ? AND d.id < ?))');
      parameters.push(beforeTs, beforeTs, beforeId!);
    }
    if (opts.failures) conditions.push("(json_type(d.meta_json, '$.error') != 'null' OR json_extract(d.meta_json, '$.status') >= 400)");
    if (opts.q) {
      conditions.push(`instr(lower(d.id || ' ' || coalesce(json_extract(d.meta_json, '$.path'), '') || ' ' || coalesce(json_extract(d.meta_json, '$.model'), '') || ' ' || coalesce(u.name, '') || ' ' || coalesce(json_extract(d.meta_json, '$.status'), '') || ' ' || coalesce(json_extract(d.meta_json, '$.error.reason'), json_extract(d.meta_json, '$.error.kind'), '')), lower(?)) > 0`);
      parameters.push(opts.q);
    }
    const { results } = await this.db
      .prepare(`${select} WHERE ${conditions.join(' AND ')} ORDER BY d.created_at DESC, d.id DESC LIMIT ?`)
      .bind(...parameters, opts.limit)
      .all<DumpMetadataRow>();
    return results.map(metadataFromRow);
  }

  async getMeta(keyId: string, recordId: DumpRecordId): Promise<DumpMetadata | null> {
    const row = await this.retainedRow(keyId, recordId);
    return row === null ? null : metadataFromRow(row);
  }

  async getArtifactStream(keyId: string, recordId: DumpRecordId): Promise<ReadableStream<Uint8Array> | null> {
    const row = await this.retainedRow(keyId, recordId);
    if (row === null) return null;
    const body = await this.files.get(row.artifact_key);
    if (body === null) throw new Error(`Dump artifact missing for key=${row.artifact_key}`);
    return gunzipStream(body);
  }

  private async retainedRow(keyId: string, recordId: DumpRecordId): Promise<DumpRow | null> {
    return await this.db.prepare(
      'SELECT d.id, d.artifact_key, d.upstream_id, u.name AS upstream_name, u.provider AS upstream_kind, u.hue AS upstream_hue, d.meta_json '
      + 'FROM dump_records d LEFT JOIN upstreams u ON u.id = d.upstream_id '
      + 'JOIN api_keys k ON k.id = d.key_id AND k.deleted_at IS NULL AND k.dump_retention_seconds IS NOT NULL '
      + 'WHERE d.key_id = ? AND d.id = ? AND d.created_at >= ? - k.dump_retention_seconds * 1000',
    ).bind(keyId, recordId, Date.now()).first<DumpRow>();
  }

  async deleteExpiredBatch(keyId: string, now: number, limit: number): Promise<number> {
    // D1 derives meta.changes from total_changes(), so the dump retirement trigger
    // can add spilled_files writes. RETURNING counts only dump rows.
    // https://github.com/cloudflare/workerd/blob/0c0f9656d3f78c75a7dc011e0c17dd85e438b44c/src/cloudflare/internal/test/d1/d1-mock.js#L83-L131
    // https://www.sqlite.org/c3ref/total_changes.html
    // https://www.sqlite.org/lang_returning.html
    const active = await this.db
      .prepare(
        `DELETE FROM dump_records WHERE rowid IN (
           SELECT records.rowid
           FROM api_keys
           CROSS JOIN dump_records AS records
           WHERE api_keys.id = ?
             AND api_keys.deleted_at IS NULL
             AND api_keys.dump_retention_seconds IS NOT NULL
             AND records.key_id = api_keys.id
             AND records.created_at < ? - api_keys.dump_retention_seconds * 1000
           ORDER BY records.created_at, records.rowid
           LIMIT ?
         )
         RETURNING rowid`,
      )
      .bind(keyId, now, limit)
      .all<{ rowid: number }>();
    const activeDeleted = active.results.length;
    if (activeDeleted >= limit) return activeDeleted;
    const inactive = await this.db
      .prepare(
        `DELETE FROM dump_records WHERE rowid IN (
           SELECT records.rowid FROM dump_records AS records
           WHERE records.key_id = ?
             AND NOT EXISTS (
               SELECT 1 FROM api_keys
               WHERE api_keys.id = records.key_id
                 AND api_keys.deleted_at IS NULL
                 AND api_keys.dump_retention_seconds IS NOT NULL
             )
           ORDER BY records.created_at, records.rowid
           LIMIT ?
         )
         RETURNING rowid`,
      )
      .bind(keyId, limit - activeDeleted)
      .all<{ rowid: number }>();
    return activeDeleted + inactive.results.length;
  }

  async findOldestCreatedAt(keyId: string): Promise<number | null> {
    const row = await this.db
      .prepare('SELECT created_at FROM dump_records WHERE key_id = ? ORDER BY created_at LIMIT 1')
      .bind(keyId)
      .first<{ created_at: number }>();
    return row?.created_at ?? null;
  }
}
