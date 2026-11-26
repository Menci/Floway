import { DUMP_FILE_PREFIX, SPILLED_FILE_STAGE_GRACE_MS } from './spilled-files-policy.ts';
import { parseUpstreamHue, parseUpstreamKind } from './upstream-parse.ts';
import { decodeDumpBodyDescriptor, decodePersistedDumpMetadata, encodeDumpBodyDescriptor, encodePersistedDumpMetadata } from '../dump/storage-codec.ts';
import type { DumpListOptions, DumpStore } from '../dump/store-contract.ts';
import type { DumpMetadata, DumpRecordId, DumpUpstreamRef } from '../dump/types.ts';
import { gzipBytes } from '../shared/gzip.ts';
import type { FileStore, SqlDatabase } from '@floway-dev/platform';

// Completed archives live at dumps/v1/{keyId}/{YYYYMMDDHH}/{recordId}-{uniqueSuffix}.ndjson.gz.

const HOUR_MS = 60 * 60 * 1000;

interface DumpRow {
  id: string;
  upstream_id: string | null;
  upstream_name: string | null;
  upstream_kind: string | null;
  upstream_hue: number | null;
  meta_json: string;
  response_body_descriptor: string | null;
}

// A null `upstream_id` means no upstream was identified at capture time
// (auth/validation reject, no candidate matched); a non-null id with a null
// joined `upstream_name` means the referenced upstream was since deleted.
// `upstreams.name`/`provider` are NOT NULL so checking name alone suffices.
// Kind and hue are both validated at read time via the shared
// `upstream-parse.ts` helpers — the write path already rejects bad values, but
// a manual DB edit / migration slip would otherwise poison every read that
// renders the badge. Same policy the SQL repo's own hydrator uses.
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

export class FileDumpStore implements DumpStore {
  constructor(private readonly db: SqlDatabase, private readonly files: FileStore) {}

  async putArchive(keyId: string, meta: DumpMetadata, archive: Uint8Array): Promise<void> {
    const key = `${DUMP_FILE_PREFIX}${keyId}/${hourBucket(meta.completedAt)}/${meta.id}-${crypto.randomUUID()}.ndjson.gz`;
    await this.db.prepare(
      `INSERT INTO spilled_files (file_key, owner_kind, owner_key, state, collect_after)
       VALUES (?, 'dump-response', json_array(?, ?), 'staged', ?)`,
    ).bind(key, keyId, meta.id, Date.now() + SPILLED_FILE_STAGE_GRACE_MS).run();
    await this.files.put(key, await gzipBytes(archive));
    await this.db.prepare(
      `INSERT INTO dump_records
       (key_id, id, created_at, upstream_id, meta_json, request_headers_json, response_body_descriptor)
       VALUES (?, ?, ?, ?, ?, '[]', ?)`,
    ).bind(
      keyId,
      meta.id,
      meta.completedAt,
      meta.upstream?.id ?? null,
      encodePersistedDumpMetadata(meta, `dump record ${meta.id} metadata`),
      encodeDumpBodyDescriptor({ key, type: 'archive' }, `dump record ${meta.id} archive descriptor`),
    ).run();
  }

  async getArchive(keyId: string, recordId: DumpRecordId): Promise<ReadableStream<Uint8Array> | null> {
    const row = await this.db.prepare(
      `SELECT d.response_body_descriptor
       FROM dump_records d
       JOIN api_keys k ON k.id = d.key_id AND k.deleted_at IS NULL AND k.dump_retention_seconds IS NOT NULL
       WHERE d.key_id = ? AND d.id = ? AND d.created_at >= ? - k.dump_retention_seconds * 1000`,
    ).bind(keyId, recordId, Date.now()).first<Pick<DumpRow, 'response_body_descriptor'>>();
    if (!row) return null;
    const descriptor = decodeDumpBodyDescriptor(row.response_body_descriptor, `dump record ${recordId} archive descriptor`);
    const compressed = await this.files.get(descriptor.key);
    if (!compressed) throw new Error(`dump archive missing for key=${descriptor.key}`);
    return new Response(compressed as Uint8Array<ArrayBuffer>).body!.pipeThrough(new DecompressionStream('gzip'));
  }

  async list(keyId: string, opts: DumpListOptions): Promise<DumpMetadata[]> {
    const beforeId = opts.before ?? null;
    const beforeRow = beforeId !== null
      ? await this.db.prepare(
          'SELECT created_at, response_body_descriptor FROM dump_records WHERE key_id = ? AND id = ?',
        ).bind(keyId, beforeId).first<Pick<DumpRow, 'response_body_descriptor'> & { created_at: number }>()
      : null;
    if (beforeId !== null && beforeRow === null) return [];
    if (beforeRow) decodeDumpBodyDescriptor(beforeRow.response_body_descriptor, `dump record ${beforeId} archive descriptor`);
    const beforeTs = beforeRow?.created_at ?? null;

    // Newest-first with a compound (created_at, id) cursor so rows sharing a
    // millisecond still page deterministically — ULID lex order matches
    // creation order within the ms.
    const select
      = 'SELECT d.id, d.meta_json, d.response_body_descriptor, d.upstream_id, u.name AS upstream_name, u.provider AS upstream_kind, u.hue AS upstream_hue '
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
    const stmt = this.db.prepare(`${select} WHERE ${conditions.join(' AND ')} ORDER BY d.created_at DESC, d.id DESC LIMIT ?`).bind(...parameters, opts.limit);
    const { results } = await stmt.all<DumpRow>();
    return results.map(row => {
      decodeDumpBodyDescriptor(row.response_body_descriptor, `dump record ${row.id} archive descriptor`);
      return {
        ...decodePersistedDumpMetadata(row.meta_json, `dump record ${row.id} metadata`),
        upstream: hydrateUpstream(row),
      };
    });
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
