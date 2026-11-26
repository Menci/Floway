import { DUMP_FILE_PREFIX, SPILLED_FILE_STAGE_GRACE_MS } from './spilled-files-policy.ts';
import { parseUpstreamHue, parseUpstreamKind } from './upstream-parse.ts';
import { dumpCaptureEnvelopeSchema } from '../dump/schemas.ts';
import {
  decodeDumpBodyDescriptor,
  decodePersistedDumpMetadata,
  encodeDumpBodyDescriptor,
  encodeDumpHeaders,
  encodeDumpStreamEvents,
  encodePersistedDumpMetadata,
} from '../dump/storage-codec.ts';
import type { DumpBodyDescriptor } from '../dump/storage-codec.ts';
import type { DumpListOptions, DumpStore } from '../dump/store-contract.ts';
import type {
  DumpMetadata,
  DumpRecordId,
  DumpUpstreamRef,
  DumpWriteRecord,
  PreparedDumpRequestBody,
} from '../dump/types.ts';
import { upstreamResponseToWire } from '../dump/wire.ts';
import { gzipBytes } from '../shared/gzip.ts';
import type { FileStore, SqlDatabase } from '@floway-dev/platform';

// Bodies live at `dumps/v1/{keyId}/{YYYYMMDDHH}/{recordId}-{uniqueSuffix}.{req|resp}.gz`.
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

const bodyPath = (keyId: string, bucket: string, recordId: string, side: 'req' | 'resp' | 'resp.up'): string =>
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

const putPreparedBody = async (
  files: FileStore,
  key: string,
  prepared: PreparedDumpRequestBody,
): Promise<DumpBodyDescriptor> => {
  const gz = prepared.encoding === 'gzip' ? prepared.bytes : await gzipBytes(prepared.bytes);
  await files.put(key, gz);
  return { key, type: 'bytes' };
};

export class FileDumpStore implements DumpStore {
  constructor(private readonly db: SqlDatabase, private readonly files: FileStore) {}

  async putArchive(keyId: string, meta: DumpMetadata, archive: Uint8Array): Promise<void> {
    const key = `${DUMP_FILE_PREFIX}${keyId}/${hourBucket(meta.completedAt)}/${meta.id}-${crypto.randomUUID()}.ndjson.gz`;
    await this.db.prepare(
      `INSERT INTO spilled_files (file_key, owner_kind, owner_key, state, collect_after)
       VALUES (?, 'dump-response', json_array(?, ?), 'staged', ?)`,
    ).bind(key, keyId, meta.id, Date.now() + SPILLED_FILE_STAGE_GRACE_MS).run();
    const descriptor = await putRawBody(this.files, key, archive, 'archive');
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
      encodeDumpBodyDescriptor(descriptor, `dump record ${meta.id} archive descriptor`),
    ).run();
  }

  async getArchive(keyId: string, recordId: DumpRecordId): Promise<ReadableStream<Uint8Array> | null> {
    const row = await this.db.prepare(
      `SELECT d.response_body_descriptor
       FROM dump_records d
       JOIN api_keys k ON k.id = d.key_id AND k.deleted_at IS NULL AND k.dump_retention_seconds IS NOT NULL
       WHERE d.key_id = ? AND d.id = ? AND d.created_at >= ? - k.dump_retention_seconds * 1000`,
    ).bind(keyId, recordId, Date.now()).first<Pick<DumpRow, 'response_body_descriptor'>>();
    if (!row?.response_body_descriptor) return null;
    const descriptor = decodeDumpBodyDescriptor(row.response_body_descriptor, `dump record ${recordId} archive descriptor`);
    if (descriptor.type !== 'archive') return null;
    const compressed = await this.files.get(descriptor.key);
    if (!compressed) throw new Error(`dump archive missing for key=${descriptor.key}`);
    return new Response(compressed as Uint8Array<ArrayBuffer>).body!.pipeThrough(new DecompressionStream('gzip'));
  }

  async prepareRequestBody(body: Uint8Array): Promise<PreparedDumpRequestBody> {
    return {
      encoding: 'gzip',
      bytes: await gzipBytes(body),
      decodedByteLength: body.byteLength,
    };
  }

  async put(keyId: string, record: DumpWriteRecord): Promise<void> {
    const bucket = hourBucket(record.meta.completedAt);
    const requestFileKey = record.request.body.decodedByteLength === 0
      ? null
      : bodyPath(keyId, bucket, record.meta.id, 'req');
    const responseFileKey = record.response.body.type === 'bytes' && record.response.body.body.byteLength === 0
      ? null
      : record.response.body.type === 'none'
        ? null
        : bodyPath(keyId, bucket, record.meta.id, 'resp');
    // The pre-translation upstream body, when present. Same descriptor shape
    // as the downstream response body (`{key, type}`), spilled under a
    // distinct `resp.up` side so the sweep can own it independently.
    const upstream = record.response.upstream;
    const upstreamBody = upstream?.body;
    const upstreamFileKey = record.capture !== undefined
      ? bodyPath(keyId, bucket, record.meta.id, 'resp.up')
      : upstreamBody === undefined
        ? null
        : upstreamBody.type === 'bytes' && upstreamBody.body.byteLength === 0
          ? null
          : upstreamBody.type === 'none'
            ? null
            : bodyPath(keyId, bucket, record.meta.id, 'resp.up');
    const staged = [
      ...(requestFileKey === null ? [] : [{ fileKey: requestFileKey, ownerKind: 'dump-request' }]),
      ...(responseFileKey === null ? [] : [{ fileKey: responseFileKey, ownerKind: 'dump-response' }]),
      ...(upstreamFileKey === null ? [] : [{ fileKey: upstreamFileKey, ownerKind: 'dump-response-upstream' }]),
    ];
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
    const requestDescriptor = record.request.body.decodedByteLength === 0
      ? null
      : await putPreparedBody(this.files, requestFileKey!, record.request.body);

    let responseDescriptor: DumpBodyDescriptor | null = null;
    if (record.response.body.type === 'bytes') {
      if (record.response.body.body.byteLength > 0) {
        responseDescriptor = await putRawBody(this.files, responseFileKey!, record.response.body.body, 'bytes');
      }
    } else if (record.response.body.type === 'stream') {
      responseDescriptor = await putRawBody(
        this.files,
        responseFileKey!,
        new TextEncoder().encode(encodeDumpStreamEvents(record.response.body.events, `dump record ${record.meta.id} response events`)),
        'events',
      );
    }

    let upstreamDescriptor: DumpBodyDescriptor | null = null;
    if (record.capture !== undefined) {
      const upstream = record.response.upstream;
      const envelope = dumpCaptureEnvelopeSchema.parse({ version: 1, capture: record.capture, ...(upstream === undefined ? {} : { upstream: upstreamResponseToWire(upstream) }) });
      upstreamDescriptor = await putRawBody(this.files, upstreamFileKey!, new TextEncoder().encode(JSON.stringify(envelope)), 'capture');
    } else if (upstreamBody !== undefined) {
      if (upstreamBody.type === 'bytes') {
        if (upstreamBody.body.byteLength > 0) {
          upstreamDescriptor = await putRawBody(this.files, upstreamFileKey!, upstreamBody.body, 'bytes');
        }
      } else if (upstreamBody.type === 'stream') {
        upstreamDescriptor = await putRawBody(
          this.files,
          upstreamFileKey!,
          new TextEncoder().encode(encodeDumpStreamEvents(upstreamBody.events, `dump record ${record.meta.id} upstream response events`)),
          'events',
        );
      }
    }

    // Files before row — a partial failure leaves orphan files the sweep
    // collects, never an orphan row whose detail fetch would 404.
    await this.db.prepare(
      `INSERT INTO dump_records
       (key_id, id, created_at, upstream_id, meta_json, request_headers_json, response_headers_json, request_body_descriptor, response_body_descriptor, response_upstream_body_descriptor)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      keyId,
      record.meta.id,
      record.meta.completedAt,
      record.meta.upstream?.id ?? null,
      encodePersistedDumpMetadata(record.meta, `dump record ${record.meta.id} metadata`),
      encodeDumpHeaders(record.request.headers, `dump record ${record.meta.id} request headers`),
      record.response.body.type === 'none'
        ? null
        : encodeDumpHeaders(record.response.headers, `dump record ${record.meta.id} response headers`),
      requestDescriptor === null
        ? null
        : encodeDumpBodyDescriptor(requestDescriptor, `dump record ${record.meta.id} request body descriptor`),
      responseDescriptor === null
        ? null
        : encodeDumpBodyDescriptor(responseDescriptor, `dump record ${record.meta.id} response body descriptor`),
      upstreamDescriptor === null
        ? null
        : encodeDumpBodyDescriptor(upstreamDescriptor, `dump record ${record.meta.id} upstream response body descriptor`),
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
