import { z } from 'zod';

import { SPILLED_FILE_STAGE_GRACE_MS } from './spilled-files-policy.ts';
import { parseUpstreamHue, parseUpstreamKind } from './upstream-parse.ts';
import type { ArchiveMetadata, CommitDumpArchive, PipelineDumpMetadata } from '../dump/archive-metadata.ts';
import type { DumpListOptions, DumpStore } from '../dump/store-contract.ts';
import type { FileStore, SqlDatabase } from '@floway-dev/platform';

const archiveMetadataSchema = z.strictObject({
  id: z.string(),
  startedAt: z.number(),
  completedAt: z.number(),
  method: z.string(),
  path: z.string(),
  status: z.number().nullable(),
  model: z.string().nullable(),
  durationMs: z.number(),
  ttftMs: z.number().nullable(),
  requestBytes: z.number(),
  responseBytes: z.number(),
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  error: z.string().nullable(),
});

interface MetadataRow {
  id: string;
  meta_json: string;
  upstream_id: string | null;
  upstream_name: string | null;
  upstream_kind: string | null;
  upstream_hue: number | null;
}

const readMetadata = (row: MetadataRow): PipelineDumpMetadata => {
  let metadata: ArchiveMetadata;
  try {
    metadata = archiveMetadataSchema.parse(JSON.parse(row.meta_json));
  } catch (error) {
    throw new Error(`Invalid metadata for pipeline dump ${row.id}`, { cause: error });
  }
  return {
    ...metadata,
    upstream: row.upstream_id === null || row.upstream_name === null ? null : {
      id: row.upstream_id,
      name: row.upstream_name,
      kind: parseUpstreamKind(row.upstream_id, row.upstream_kind),
      hue: parseUpstreamHue(row.upstream_id, row.upstream_hue),
    },
  };
};

const retainedJoin = 'JOIN api_keys k ON k.id = d.key_id AND k.deleted_at IS NULL AND k.dump_retention_seconds IS NOT NULL';
const retainedWhere = 'd.key_id = ? AND d.created_at >= ? - k.dump_retention_seconds * 1000';

export class FileDumpStore implements DumpStore {
  constructor(private readonly db: SqlDatabase, private readonly files: FileStore) {}

  async writeArchive(keyId: string, id: string, bytes: ReadableStream<Uint8Array>): Promise<CommitDumpArchive> {
    const key = `dumps/v2/${keyId}/${id}.ndjson`;
    await this.db.prepare(
      `INSERT INTO spilled_files (file_key, owner_kind, owner_key, state, collect_after)
       VALUES (?, 'dump-archive', json_array(?, ?), 'staged', ?)`,
    ).bind(key, keyId, id, Date.now() + SPILLED_FILE_STAGE_GRACE_MS).run();
    await this.files.putStream(key, bytes);
    return async (metadata, upstreamId) => {
      if (metadata.id !== id) throw new TypeError('Dump metadata ID does not match the archive');
      await this.db.prepare(
        `INSERT INTO dump_records (key_id, id, created_at, upstream_id, meta_json, archive_file_key)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(keyId, id, metadata.completedAt, upstreamId, JSON.stringify(archiveMetadataSchema.parse(metadata)), key).run();
    };
  }

  async list(keyId: string, options: DumpListOptions): Promise<PipelineDumpMetadata[]> {
    const now = Date.now();
    const where = [retainedWhere];
    const parameters: (string | number)[] = [keyId, now];
    if (options.before !== undefined) {
      const before = await this.db.prepare('SELECT created_at FROM dump_records WHERE key_id = ? AND id = ?')
        .bind(keyId, options.before).first<{ created_at: number }>();
      if (!before) return [];
      where.push('(d.created_at < ? OR (d.created_at = ? AND d.id < ?))');
      parameters.push(before.created_at, before.created_at, options.before);
    }
    if (options.failures) where.push("(json_extract(d.meta_json, '$.error') IS NOT NULL OR json_extract(d.meta_json, '$.status') >= 400)");
    if (options.q) {
      where.push(`instr(lower(d.id || ' ' || coalesce(json_extract(d.meta_json, '$.path'), '') || ' '
        || coalesce(json_extract(d.meta_json, '$.model'), '') || ' ' || coalesce(u.name, '') || ' '
        || coalesce(json_extract(d.meta_json, '$.status'), '') || ' ' || coalesce(json_extract(d.meta_json, '$.error'), '')), lower(?)) > 0`);
      parameters.push(options.q);
    }
    const { results } = await this.db.prepare(
      `SELECT d.id, d.meta_json, d.upstream_id, u.name AS upstream_name, u.provider AS upstream_kind, u.hue AS upstream_hue
       FROM dump_records d LEFT JOIN upstreams u ON u.id = d.upstream_id
       ${retainedJoin}
       WHERE ${where.join(' AND ')}
       ORDER BY d.created_at DESC, d.id DESC LIMIT ?`,
    ).bind(...parameters, options.limit).all<MetadataRow>();
    return results.map(readMetadata);
  }

  async get(keyId: string, recordId: string): Promise<ReadableStream<Uint8Array> | null> {
    const row = await this.db.prepare(
      `SELECT d.archive_file_key FROM dump_records d
       ${retainedJoin}
       WHERE ${retainedWhere} AND d.id = ?`,
    ).bind(keyId, Date.now(), recordId).first<{ archive_file_key: string }>();
    if (row === null) return null;
    const archive = await this.files.getStream(row.archive_file_key);
    if (archive === null) throw new Error(`Missing pipeline dump archive ${row.archive_file_key}`);
    return archive;
  }

  async deleteExpiredBatch(keyId: string, now: number, limit: number): Promise<number> {
    // D1 derives meta.changes from total_changes(), which includes the file
    // retirement trigger. RETURNING limits the count to retired dump rows.
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
