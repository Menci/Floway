import { DUMP_FILE_PREFIX, SPILLED_FILE_STAGE_GRACE_MS } from './spilled-files-policy.ts';
import { parseUpstreamHue, parseUpstreamKind } from './upstream-parse.ts';
import {
  decodeDumpBodyDescriptor,
  decodePersistedDumpMetadata,
  encodeDumpBodyDescriptor,
  encodePersistedDumpMetadata,
} from '../dump/storage-codec.ts';
import type { DumpBodyDescriptor } from '../dump/storage-codec.ts';
import type { DumpListOptions, DumpStore } from '../dump/store-contract.ts';
import type {
  DumpMetadata,
  DumpRecordId,
  DumpUpstreamRef,
  DumpWriteRecord,
  StoredDumpRecord,
} from '../dump/types.ts';
import { gunzipBytes, gzipBytes } from '../shared/gzip.ts';
import type { FileStore, SqlDatabase } from '@floway-dev/platform';

// Bodies live at `dumps/v1/{keyId}/{YYYYMMDDHH}/{recordId}-{uniqueSuffix}.{req|resp|run}.gz`.
// The hour segment remains useful for operator inspection; lifecycle and
// collection are driven by the shared spilled_files registry.

const HOUR_MS = 60 * 60 * 1000;

interface DumpRow {
  id: string;
  upstream_id: string | null;
  upstream_name: string | null;
  upstream_kind: string | null;
  upstream_hue: number | null;
  meta_json: string;
  request_headers_json: string;
  response_headers_json: string | null;
  request_body_descriptor: string | null;
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

const bodyPath = (keyId: string, bucket: string, recordId: string, side: 'req' | 'resp' | 'run'): string =>
  `${DUMP_FILE_PREFIX}${keyId}/${bucket}/${recordId}-${crypto.randomUUID()}.${side}.gz`;

const putRawBody = async (
  files: FileStore,
  key: string,
  rawBytes: Uint8Array,
  type: DumpBodyDescriptor['type'],
): Promise<DumpBodyDescriptor> => {
  const gz = await gzipBytes(rawBytes);
  await files.put(key, gz);
  return { key, type };
};

const fetchBody = async (files: FileStore, descriptor: DumpBodyDescriptor): Promise<Uint8Array> => {
  const gz = await files.get(descriptor.key);
  if (!gz) throw new Error(`dump body missing for key=${descriptor.key}`);
  return await gunzipBytes(gz);
};

// A run record has no edge halves at row level — its request and response are
// events inside the stream — and `request_headers_json` is NOT NULL. The empty
// list is how the row spells "this shape has none"; nothing reads it back,
// because `get` dispatches on the body descriptor first.
const NO_EDGE_HEADERS = '[]';

export class FileDumpStore implements DumpStore {
  constructor(private readonly db: SqlDatabase, private readonly files: FileStore) {}

  // A run's NDJSON is one body file, staged in the registry, written, and only
  // then pointed at by a row — the contract that leaves retention, the sweep and
  // the files-before-row ordering saying what they always said.
  async put(keyId: string, record: DumpWriteRecord): Promise<void> {
    const bucket = hourBucket(record.meta.completedAt);
    const responseFileKey = bodyPath(keyId, bucket, record.meta.id, 'run');
    const staged = [{ fileKey: responseFileKey, ownerKind: 'dump-response' }];
    if (staged.length > 0) {
      await this.db
        .prepare(
          `INSERT INTO spilled_files (file_key, owner_kind, owner_key, state, collect_after)
           SELECT
             json_extract(value, '$.fileKey'),
             json_extract(value, '$.ownerKind'),
             json_array(?, ?),
             'staged',
             ?
           FROM json_each(?)`,
        )
        .bind(keyId, record.meta.id, Date.now() + SPILLED_FILE_STAGE_GRACE_MS, JSON.stringify(staged))
        .run();
    }

    const responseDescriptor = await putRawBody(this.files, responseFileKey, record.events, 'run');

    // Files before row — a partial failure leaves orphan files the sweep
    // collects, never an orphan row whose detail fetch would 404.
    await this.db.prepare(
      `INSERT INTO dump_records
       (key_id, id, created_at, upstream_id, meta_json, request_headers_json, response_headers_json, request_body_descriptor, response_body_descriptor)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      keyId,
      record.meta.id,
      record.meta.completedAt,
      record.meta.upstream?.id ?? null,
      encodePersistedDumpMetadata(record.meta, `dump record ${record.meta.id} metadata`),
      NO_EDGE_HEADERS,
      null,
      null,
      responseDescriptor === null
        ? null
        : encodeDumpBodyDescriptor(responseDescriptor, `dump record ${record.meta.id} response body descriptor`),
    ).run();
  }

  async list(keyId: string, opts: DumpListOptions): Promise<DumpMetadata[]> {
    const beforeId = opts.before ?? null;
    const beforeRow = beforeId !== null
      ? await this.db.prepare(
          'SELECT created_at FROM dump_records WHERE key_id = ? AND id = ?',
        ).bind(keyId, beforeId).first<{ created_at: number }>()
      : null;
    if (beforeId !== null && beforeRow === null) return [];
    const beforeTs = beforeRow?.created_at ?? null;

    // Newest-first with a compound (created_at, id) cursor so rows sharing a
    // millisecond still page deterministically — ULID lex order matches
    // creation order within the ms.
    const select
      = 'SELECT d.id, d.meta_json, d.upstream_id, u.name AS upstream_name, u.provider AS upstream_kind, u.hue AS upstream_hue '
      + 'FROM dump_records d LEFT JOIN upstreams u ON u.id = d.upstream_id '
      + 'JOIN api_keys k ON k.id = d.key_id AND k.deleted_at IS NULL AND k.dump_retention_seconds IS NOT NULL ';
    const visible = 'd.key_id = ? AND d.created_at >= ? - k.dump_retention_seconds * 1000';
    const sql = beforeTs === null
      ? `${select} WHERE ${visible} ORDER BY d.created_at DESC, d.id DESC LIMIT ?`
      : `${select} WHERE ${visible} AND (d.created_at < ? OR (d.created_at = ? AND d.id < ?)) ORDER BY d.created_at DESC, d.id DESC LIMIT ?`;
    const now = Date.now();
    const stmt = beforeTs === null
      ? this.db.prepare(sql).bind(keyId, now, opts.limit)
      : this.db.prepare(sql).bind(keyId, now, beforeTs, beforeTs, beforeId, opts.limit);
    const { results } = await stmt.all<Pick<DumpRow, 'id' | 'meta_json' | 'upstream_id' | 'upstream_name' | 'upstream_kind' | 'upstream_hue'>>();
    return results.map(row => ({
      ...decodePersistedDumpMetadata(row.meta_json, `dump record ${row.id} metadata`),
      upstream: hydrateUpstream(row),
    }));
  }

  async get(keyId: string, recordId: DumpRecordId): Promise<StoredDumpRecord | null> {
    const row = await this.db.prepare(
      'SELECT d.id, d.upstream_id, u.name AS upstream_name, u.provider AS upstream_kind, u.hue AS upstream_hue, '
      + 'd.meta_json, d.request_headers_json, d.response_headers_json, d.request_body_descriptor, d.response_body_descriptor '
      + 'FROM dump_records d LEFT JOIN upstreams u ON u.id = d.upstream_id '
      + 'JOIN api_keys k ON k.id = d.key_id AND k.deleted_at IS NULL AND k.dump_retention_seconds IS NOT NULL '
      + 'WHERE d.key_id = ? AND d.id = ? AND d.created_at >= ? - k.dump_retention_seconds * 1000',
    ).bind(keyId, recordId, Date.now()).first<DumpRow>();
    if (!row) return null;

    const meta: DumpMetadata = {
      ...decodePersistedDumpMetadata(row.meta_json, `dump record ${recordId} metadata`),
      upstream: hydrateUpstream(row),
    };
    const responseDescriptor = row.response_body_descriptor === null
      ? null
      : decodeDumpBodyDescriptor(row.response_body_descriptor, `dump record ${recordId} response body descriptor`);
    // A record is one NDJSON stream, carried by the response descriptor and saying so. Anything
    // else is a row from before the shape that produced it was deleted, which the migration that
    // deleted them leaves none of — so it is corruption rather than a second shape.
    if (responseDescriptor?.type !== 'run') {
      throw new Error(`dump record ${recordId} has no run stream to read`);
    }
    return { meta, events: await fetchBody(this.files, responseDescriptor) };
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
