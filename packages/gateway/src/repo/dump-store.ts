import { DUMP_FILE_PREFIX, SPILLED_FILE_STAGE_GRACE_MS } from './spilled-files-policy.ts';
import { parseUpstreamHue, parseUpstreamKind } from './upstream-parse.ts';
import {
  decodeDumpBodyDescriptor,
  decodeDumpHeaders,
  decodeDumpStreamEvents,
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
  StoredDumpRecord,
  StoredDumpRequest,
  StoredDumpResponse,
  StoredDumpResponseBody,
} from '../dump/types.ts';
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

const bodyPath = (keyId: string, bucket: string, recordId: string, side: 'req' | 'resp'): string =>
  `${DUMP_FILE_PREFIX}${keyId}/${bucket}/${recordId}-${crypto.randomUUID()}.${side}.gz`;

const gzip = async (bytes: Uint8Array): Promise<Uint8Array> => {
  const stream = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('gzip')));
  return new Uint8Array(await stream.arrayBuffer());
};

const gunzip = async (bytes: Uint8Array): Promise<Uint8Array> => {
  const stream = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip')));
  return new Uint8Array(await stream.arrayBuffer());
};

const putRawBody = async (
  files: FileStore,
  key: string,
  rawBytes: Uint8Array,
  type: 'bytes' | 'events',
): Promise<DumpBodyDescriptor> => {
  const gz = await gzip(rawBytes);
  await files.put(key, gz);
  return { key, type };
};

const putPreparedBody = async (
  files: FileStore,
  key: string,
  prepared: PreparedDumpRequestBody,
): Promise<DumpBodyDescriptor> => {
  const gz = prepared.encoding === 'gzip' ? prepared.bytes : await gzip(prepared.bytes);
  await files.put(key, gz);
  return { key, type: 'bytes' };
};

const fetchBody = async (files: FileStore, descriptor: DumpBodyDescriptor): Promise<Uint8Array> => {
  const gz = await files.get(descriptor.key);
  if (!gz) throw new Error(`dump body missing for key=${descriptor.key}`);
  return await gunzip(gz);
};

export class FileDumpStore implements DumpStore {
  constructor(private readonly db: SqlDatabase, private readonly files: FileStore) {}

  async prepareRequestBody(body: Uint8Array): Promise<PreparedDumpRequestBody> {
    return {
      encoding: 'gzip',
      bytes: await gzip(body),
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
    const staged = [
      ...(requestFileKey === null ? [] : [{ fileKey: requestFileKey, ownerKind: 'dump-request' }]),
      ...(responseFileKey === null ? [] : [{ fileKey: responseFileKey, ownerKind: 'dump-response' }]),
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
    const requestHeaders = decodeDumpHeaders(row.request_headers_json, `dump record ${recordId} request headers`);
    const requestDescriptor = row.request_body_descriptor === null
      ? null
      : decodeDumpBodyDescriptor(row.request_body_descriptor, `dump record ${recordId} request body descriptor`);
    const responseHeaders = row.response_headers_json === null
      ? null
      : decodeDumpHeaders(row.response_headers_json, `dump record ${recordId} response headers`);
    const responseDescriptor = row.response_body_descriptor === null
      ? null
      : decodeDumpBodyDescriptor(row.response_body_descriptor, `dump record ${recordId} response body descriptor`);

    const request: StoredDumpRequest = {
      method: meta.method,
      path: meta.path,
      headers: requestHeaders,
      body: requestDescriptor ? await fetchBody(this.files, requestDescriptor) : new Uint8Array(),
    };

    // Headers null iff `type: 'none'`; a null descriptor with headers is a
    // legitimate empty-body `bytes` response (nothing to gzip), reconstructed
    // here from a zero-length buffer so the discriminator round-trips.
    let responseBody: StoredDumpResponseBody;
    if (responseHeaders === null) {
      responseBody = { type: 'none' };
    } else if (responseDescriptor === null) {
      responseBody = { type: 'bytes', body: new Uint8Array() };
    } else if (responseDescriptor.type === 'events') {
      const text = new TextDecoder().decode(await fetchBody(this.files, responseDescriptor));
      responseBody = {
        type: 'stream',
        events: decodeDumpStreamEvents(text, `dump record ${recordId} response events at key=${responseDescriptor.key}`),
      };
    } else {
      responseBody = { type: 'bytes', body: await fetchBody(this.files, responseDescriptor) };
    }

    const response: StoredDumpResponse = {
      status: meta.status,
      headers: responseHeaders ?? [],
      body: responseBody,
    };
    return { meta, request, response };
  }

  async deleteExpiredBatch(keyId: string, now: number, limit: number): Promise<number> {
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
         )`,
      )
      .bind(keyId, now, limit)
      .run();
    const activeDeleted = active.meta.changes ?? 0;
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
         )`,
      )
      .bind(keyId, limit - activeDeleted)
      .run();
    return activeDeleted + (inactive.meta.changes ?? 0);
  }

  async findOldestCreatedAt(keyId: string): Promise<number | null> {
    const row = await this.db
      .prepare('SELECT created_at FROM dump_records WHERE key_id = ? ORDER BY created_at LIMIT 1')
      .bind(keyId)
      .first<{ created_at: number }>();
    return row?.created_at ?? null;
  }
}
