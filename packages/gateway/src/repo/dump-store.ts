import { DUMP_FILE_PREFIX, SPILLED_FILE_STAGE_GRACE_MS } from './spilled-files-policy.ts';
import { parseUpstreamHue, parseUpstreamKind } from './upstream-parse.ts';
import {
  decodeDumpBodyDescriptor,
  decodePersistedDumpMetadata,
  encodeDumpBodyDescriptor,
  encodePersistedDumpMetadata,
} from '../dump/storage-codec.ts';
import type { DumpBodyDescriptor } from '../dump/storage-codec.ts';
import type { DumpListOptions, DumpStore, DumpRunWrite } from '../dump/store-contract.ts';
import type {
  DumpMetadata,
  DumpRecordId,
  DumpUpstreamRef,
  StoredDumpRecord,
} from '../dump/types.ts';
import { gunzipBytes, gzipStream } from '../shared/gzip.ts';
import type { FileStore, SqlDatabase } from '@floway-dev/platform';

// Bodies live at `dumps/v1/{keyId}/{YYYYMMDDHH}/{recordId}-{uniqueSuffix}.run.gz`.
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
  response_body_descriptor: string | null;
}

// A null `upstream_id` means no upstream was identified for the run
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

const bodyPath = (keyId: string, bucket: string, recordId: string): string =>
  `${DUMP_FILE_PREFIX}${keyId}/${bucket}/${recordId}-${crypto.randomUUID()}.run.gz`;

const fetchBody = async (files: FileStore, descriptor: DumpBodyDescriptor): Promise<Uint8Array> => {
  const gz = await files.get(descriptor.key);
  if (!gz) throw new Error(`dump body missing for key=${descriptor.key}`);
  return await gunzipBytes(gz);
};

// The SQL row requires request_headers_json; headers themselves live in run facts.
const EMPTY_HEADERS_JSON = '[]';

export class FileDumpStore implements DumpStore {
  constructor(private readonly db: SqlDatabase, private readonly files: FileStore) {}

  async putRun(keyId: string, run: DumpRunWrite): Promise<void> {
    const fileKey = bodyPath(keyId, hourBucket(run.startedAt), run.id);
    await this.db.prepare(
      `INSERT INTO spilled_files (file_key, owner_kind, owner_key, state, collect_after)
       VALUES (?, 'dump-response', ?, 'staged', ?)`,
    ).bind(fileKey, JSON.stringify([keyId, run.id]), Date.now() + SPILLED_FILE_STAGE_GRACE_MS).run();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    let renewal: Promise<void> = Promise.resolve();
    const stopRenewing = () => { finished = true; clearTimeout(timer); };
    const scheduleRenewal = () => {
      timer = setTimeout(() => {
        renewal = this.db.prepare(
          "UPDATE spilled_files SET collect_after = ? WHERE file_key = ? AND state = 'staged'",
        ).bind(Date.now() + SPILLED_FILE_STAGE_GRACE_MS, fileKey).run().then(() => {
          if (!finished) scheduleRenewal();
        });
        // Awaited before publication even if the lease write failed while upstream was quiet.
        void renewal.catch(() => {});
      }, SPILLED_FILE_STAGE_GRACE_MS / 2);
    };
    scheduleRenewal();
    try {
      await this.files.put(fileKey, gzipStream(run.events));
      const meta = await run.metadata;
      stopRenewing();
      await renewal;
      await this.db.prepare(
        `INSERT INTO dump_records
         (key_id, id, created_at, upstream_id, meta_json, request_headers_json, response_headers_json, request_body_descriptor, response_body_descriptor, response_upstream_body_descriptor)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL)`,
      ).bind(
        keyId, meta.id, meta.completedAt, meta.upstream?.id ?? null,
        encodePersistedDumpMetadata(meta, `dump record ${meta.id} metadata`), EMPTY_HEADERS_JSON,
        encodeDumpBodyDescriptor({ key: fileKey, type: 'run' }, `dump record ${meta.id} run descriptor`),
      ).run();
    } finally { stopRenewing(); }
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
    const { results } = await stmt.all<Pick<DumpRow, 'id' | 'meta_json' | 'upstream_id' | 'upstream_name' | 'upstream_kind' | 'upstream_hue'>>();
    return results.map(row => ({
      ...decodePersistedDumpMetadata(row.meta_json, `dump record ${row.id} metadata`),
      upstream: hydrateUpstream(row),
    }));
  }

  async get(keyId: string, recordId: DumpRecordId): Promise<StoredDumpRecord | null> {
    const row = await this.db.prepare(
      'SELECT d.id, d.upstream_id, u.name AS upstream_name, u.provider AS upstream_kind, u.hue AS upstream_hue, '
      + 'd.meta_json, d.response_body_descriptor '
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
