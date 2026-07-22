import { parseUpstreamColor, parseUpstreamKind } from './upstream-parse.ts';
import type { DumpListOptions, DumpStore } from '../dump/store-contract.ts';
import type {
  DumpMetadata,
  DumpRecordId,
  DumpStreamEvent,
  DumpUpstreamRef,
  DumpWriteRecord,
  PreparedDumpRequestBody,
  StoredDumpRecord,
  StoredDumpRequest,
  StoredDumpResponse,
  StoredDumpResponseBody,
} from '../dump/types.ts';
import type { FileProvider, SqlDatabase } from '@floway-dev/platform';

// Bodies live at `dumps/v1/{keyId}/{YYYYMMDDHH}/{recordId}-{nonce}.{req|resp}.gz`.
// The hour segment keeps operator inspection chronological; maintenance owns
// exact file keys through its staged GC instead of scanning the prefix.

const ROOT = 'dumps/v1';
const HOUR_MS = 60 * 60 * 1000;
const MAINTENANCE_ROW_BATCH_SIZE = 500;
const MAINTENANCE_FILE_BATCH_SIZE = 1_000;
const FILE_STAGE_GRACE_MS = 60 * 60 * 1000;
const CLAIM_TIMEOUT_MS = 60 * 60 * 1000;

interface BodyDescriptor {
  key: string;
  type: 'bytes' | 'events';
}

interface DumpRow {
  upstream_id: string | null;
  upstream_name: string | null;
  upstream_kind: string | null;
  upstream_color: string | null;
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
// `upstream_color` is nullable in the upstreams table itself (NULL means
// "inherit the frontend's kind default"). Kind and color are both validated
// at read time via the shared `upstream-parse.ts` helpers — the write path
// already rejects bad values, but a manual DB edit / migration slip would
// otherwise poison every read that renders the badge. Same policy the SQL
// repo's own hydrator uses.
const hydrateUpstream = (row: Pick<DumpRow, 'upstream_id' | 'upstream_name' | 'upstream_kind' | 'upstream_color'>): DumpUpstreamRef | null => {
  if (row.upstream_id === null || row.upstream_name === null) return null;
  return {
    id: row.upstream_id,
    name: row.upstream_name,
    kind: parseUpstreamKind(row.upstream_id, row.upstream_kind),
    color: parseUpstreamColor(row.upstream_id, row.upstream_color),
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

const hourBucketToMs = (bucket: string): number | null => {
  if (!/^\d{10}$/.test(bucket)) return null;
  const y = Number(bucket.slice(0, 4));
  const m = Number(bucket.slice(4, 6));
  const d = Number(bucket.slice(6, 8));
  const h = Number(bucket.slice(8, 10));
  return Date.UTC(y, m - 1, d, h, 0, 0, 0);
};

const keyPrefix = (keyId: string): string => `${ROOT}/${keyId}/`;
const bucketPrefix = (keyId: string, bucket: string): string => `${ROOT}/${keyId}/${bucket}/`;
const bodyPath = (keyId: string, bucket: string, recordId: string, side: 'req' | 'resp'): string =>
  `${bucketPrefix(keyId, bucket)}${recordId}-${crypto.randomUUID()}.${side}.gz`;

const gzip = async (bytes: Uint8Array): Promise<Uint8Array> => {
  const stream = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('gzip')));
  return new Uint8Array(await stream.arrayBuffer());
};

const gunzip = async (bytes: Uint8Array): Promise<Uint8Array> => {
  const stream = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip')));
  return new Uint8Array(await stream.arrayBuffer());
};

const putRawBody = async (
  files: FileProvider,
  key: string,
  rawBytes: Uint8Array,
  type: 'bytes' | 'events',
): Promise<BodyDescriptor> => {
  const gz = await gzip(rawBytes);
  await files.put(key, gz);
  return { key, type };
};

const putPreparedBody = async (
  files: FileProvider,
  key: string,
  prepared: PreparedDumpRequestBody,
): Promise<BodyDescriptor> => {
  const gz = prepared.encoding === 'gzip' ? prepared.bytes : await gzip(prepared.bytes);
  await files.put(key, gz);
  return { key, type: 'bytes' };
};

const fetchBody = async (files: FileProvider, descriptor: BodyDescriptor): Promise<Uint8Array> => {
  const gz = await files.get(descriptor.key);
  if (!gz) throw new Error(`dump body missing for key=${descriptor.key}`);
  return await gunzip(gz);
};

export class FileDumpStore implements DumpStore {
  constructor(private readonly db: SqlDatabase, private readonly files: FileProvider) {}

  async prepareRequestBody(body: Uint8Array): Promise<PreparedDumpRequestBody> {
    return {
      encoding: 'gzip',
      bytes: await gzip(body),
      decodedByteLength: body.byteLength,
    };
  }

  async put(keyId: string, record: DumpWriteRecord): Promise<void> {
    const bucket = hourBucket(record.meta.completedAt);
    const requestFileKey = record.request.body.decodedByteLength === 0 ? null : bodyPath(keyId, bucket, record.meta.id, 'req');
    const responseFileKey = record.response.body.type === 'bytes' && record.response.body.body.byteLength === 0
      ? null
      : record.response.body.type === 'none' ? null : bodyPath(keyId, bucket, record.meta.id, 'resp');
    const stagedKeys = [requestFileKey, responseFileKey].filter(key => key !== null);
    if (stagedKeys.length > 0) {
      await this.db
        .prepare(
          `INSERT INTO dump_file_gc (file_key, eligible_at)
           SELECT value, ? FROM json_each(?)`,
        )
        .bind(Date.now() + FILE_STAGE_GRACE_MS, JSON.stringify(stagedKeys))
        .run();
    }
    try {
      const requestDescriptor = record.request.body.decodedByteLength === 0
        ? null
        : await putPreparedBody(this.files, requestFileKey!, record.request.body);

      let responseDescriptor: BodyDescriptor | null = null;
      if (record.response.body.type === 'bytes') {
        if (record.response.body.body.byteLength > 0) {
          responseDescriptor = await putRawBody(this.files, responseFileKey!, record.response.body.body, 'bytes');
        }
      } else if (record.response.body.type === 'stream') {
        responseDescriptor = await putRawBody(this.files, responseFileKey!, new TextEncoder().encode(JSON.stringify(record.response.body.events)), 'events');
      }

      // Strip the in-memory `upstream` field; the ref is rebuilt from the join
      // at read time so renames and deletes are honored on historical rows.
      const { upstream: _upstream, ...metaToStore } = record.meta;

      // Files before row — a partial failure leaves staged files the exact-key
      // GC can collect, never an orphan row whose detail fetch would 404.
      await this.db.prepare(
        `INSERT INTO dump_records
         (key_id, id, created_at, upstream_id, meta_json, request_headers_json, response_headers_json, request_body_descriptor, response_body_descriptor)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        keyId,
        record.meta.id,
        record.meta.completedAt,
        record.meta.upstream?.id ?? null,
        JSON.stringify(metaToStore),
        JSON.stringify(record.request.headers),
        record.response.body.type === 'none' ? null : JSON.stringify(record.response.headers),
        requestDescriptor === null ? null : JSON.stringify(requestDescriptor),
        responseDescriptor === null ? null : JSON.stringify(responseDescriptor),
      ).run();
    } catch (error) {
      try {
        await this.files.deleteKeys(stagedKeys);
        if (stagedKeys.length > 0) {
          await this.db
            .prepare('DELETE FROM dump_file_gc WHERE claim_token IS NULL AND file_key IN (SELECT value FROM json_each(?))')
            .bind(JSON.stringify(stagedKeys))
            .run();
        }
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Dump write and staged-file cleanup failed');
      }
      throw error;
    }
  }

  async list(keyId: string, opts: DumpListOptions): Promise<DumpMetadata[]> {
    const beforeId = opts.before ?? null;
    const beforeRow = beforeId !== null
      ? await this.db.prepare(
          'SELECT created_at FROM dump_records WHERE key_id = ? AND id = ?',
        ).bind(keyId, beforeId).first<{ created_at: number }>()
      : null;
    const beforeTs = beforeRow?.created_at ?? null;

    // Newest-first with a compound (created_at, id) cursor so rows sharing a
    // millisecond still page deterministically — ULID lex order matches
    // creation order within the ms.
    const select
      = 'SELECT d.meta_json, d.upstream_id, u.name AS upstream_name, u.provider AS upstream_kind, u.color AS upstream_color '
      + 'FROM dump_records d LEFT JOIN upstreams u ON u.id = d.upstream_id';
    const sql = beforeTs === null
      ? `${select} WHERE d.key_id = ? ORDER BY d.created_at DESC, d.id DESC LIMIT ?`
      : `${select} WHERE d.key_id = ? AND (d.created_at < ? OR (d.created_at = ? AND d.id < ?)) ORDER BY d.created_at DESC, d.id DESC LIMIT ?`;
    const stmt = beforeTs === null
      ? this.db.prepare(sql).bind(keyId, opts.limit)
      : this.db.prepare(sql).bind(keyId, beforeTs, beforeTs, beforeId, opts.limit);
    const { results } = await stmt.all<Pick<DumpRow, 'meta_json' | 'upstream_id' | 'upstream_name' | 'upstream_kind' | 'upstream_color'>>();
    return results.map(row => ({
      ...JSON.parse(row.meta_json) as Omit<DumpMetadata, 'upstream'>,
      upstream: hydrateUpstream(row),
    }));
  }

  async get(keyId: string, recordId: DumpRecordId): Promise<StoredDumpRecord | null> {
    const row = await this.db.prepare(
      'SELECT d.upstream_id, u.name AS upstream_name, u.provider AS upstream_kind, u.color AS upstream_color, '
      + 'd.meta_json, d.request_headers_json, d.response_headers_json, d.request_body_descriptor, d.response_body_descriptor '
      + 'FROM dump_records d LEFT JOIN upstreams u ON u.id = d.upstream_id '
      + 'WHERE d.key_id = ? AND d.id = ?',
    ).bind(keyId, recordId).first<DumpRow>();
    if (!row) return null;

    const meta: DumpMetadata = {
      ...JSON.parse(row.meta_json) as Omit<DumpMetadata, 'upstream'>,
      upstream: hydrateUpstream(row),
    };
    const requestHeaders = JSON.parse(row.request_headers_json) as Array<[string, string]>;
    const requestDescriptor = row.request_body_descriptor ? JSON.parse(row.request_body_descriptor) as BodyDescriptor : null;
    const responseHeaders = row.response_headers_json ? JSON.parse(row.response_headers_json) as Array<[string, string]> : null;
    const responseDescriptor = row.response_body_descriptor ? JSON.parse(row.response_body_descriptor) as BodyDescriptor : null;

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
      const parsed = JSON.parse(new TextDecoder().decode(await fetchBody(this.files, responseDescriptor))) as unknown;
      if (!Array.isArray(parsed)) throw new Error(`dump events payload not an array at key=${responseDescriptor.key}`);
      responseBody = { type: 'stream', events: parsed as DumpStreamEvent[] };
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

  async purgeAll(keyId: string): Promise<void> {
    // Files before rows, matching `put`'s ordering invariant.
    await this.files.deletePrefix(keyPrefix(keyId));
    await this.db.prepare('DELETE FROM dump_records WHERE key_id = ?').bind(keyId).run();
  }

  async purgeExpired(keyId: string, retentionSeconds: number): Promise<void> {
    const cutoff = Date.now() - retentionSeconds * 1000;

    // FileProvider has no delimiter-aware list, so derive the hour buckets by
    // scanning all keys under the prefix and grouping on the first segment.
    const prefix = keyPrefix(keyId);
    const buckets = new Set<string>();
    for (const file of await this.files.listKeys(prefix)) {
      const tail = file.slice(prefix.length);
      const slash = tail.indexOf('/');
      if (slash > 0) buckets.add(tail.slice(0, slash));
    }
    for (const bucket of buckets) {
      const bucketStart = hourBucketToMs(bucket);
      if (bucketStart === null) continue;
      const bucketEnd = bucketStart + HOUR_MS;
      if (bucketEnd <= cutoff) await this.files.deletePrefix(bucketPrefix(keyId, bucket));
    }

    await this.db.prepare('DELETE FROM dump_records WHERE key_id = ? AND created_at < ?').bind(keyId, cutoff).run();
  }

  async backfillMaintenanceBatch(): Promise<boolean> {
    const backfill = await this.db
      .prepare('SELECT next_rowid, complete FROM dump_maintenance_backfill WHERE id = 1')
      .first<{ next_rowid: number; complete: number }>();
    if (backfill === null) throw new Error('dump_maintenance_backfill singleton row missing');
    if (backfill.complete === 0) {
      const { results } = await this.db
        .prepare('SELECT rowid, key_id FROM dump_records WHERE rowid > ? ORDER BY rowid LIMIT ?')
        .bind(backfill.next_rowid, MAINTENANCE_ROW_BATCH_SIZE)
        .all<{ rowid: number; key_id: string }>();
      if (results.length > 0) {
        await this.db
          .prepare(
            `INSERT INTO dump_maintenance_keys (key_id, due_at)
             SELECT DISTINCT json_extract(value, '$.keyId'), 0 FROM json_each(?)
             ON CONFLICT (key_id) DO UPDATE SET
               due_at = 0,
               revision = dump_maintenance_keys.revision + 1`,
          )
          .bind(JSON.stringify(results.map(row => ({ keyId: row.key_id }))))
          .run();
        await this.db
          .prepare('UPDATE dump_maintenance_backfill SET next_rowid = ? WHERE id = 1')
          .bind(results.at(-1)!.rowid)
          .run();
        return true;
      }
      await this.db.prepare('UPDATE dump_maintenance_backfill SET complete = 1 WHERE id = 1').run();
    }
    return false;
  }

  async purgeNextMaintenanceBatch(now: number): Promise<boolean> {
    const gcToken = crypto.randomUUID();
    const { results: gcRows } = await this.db
      .prepare(
        `UPDATE dump_file_gc
         SET claim_token = ?, claimed_at = ?
         WHERE file_key IN (
           SELECT file_key FROM dump_file_gc
           WHERE eligible_at <= ? AND (claim_token IS NULL OR claimed_at <= ?)
           ORDER BY eligible_at, file_key LIMIT ?
         )
         RETURNING file_key`,
      )
      .bind(gcToken, now, now, now - CLAIM_TIMEOUT_MS, MAINTENANCE_FILE_BATCH_SIZE)
      .all<{ file_key: string }>();
    if (gcRows.length > 0) {
      await this.files.deleteKeys(gcRows.map(row => row.file_key));
      await this.db.prepare('DELETE FROM dump_file_gc WHERE claim_token = ?').bind(gcToken).run();
    }

    const token = crypto.randomUUID();
    const { results: claims } = await this.db
      .prepare(
        `UPDATE dump_maintenance_keys
         SET claim_token = ?, claimed_at = ?
         WHERE key_id = (
           SELECT key_id FROM dump_maintenance_keys
           WHERE due_at <= ? AND (claim_token IS NULL OR claimed_at <= ?)
           ORDER BY due_at, key_id LIMIT 1
         )
         RETURNING key_id, revision`,
      )
      .bind(token, now, now, now - CLAIM_TIMEOUT_MS)
      .all<{ key_id: string; revision: number }>();
    const claim = claims[0];
    if (claim === undefined) return gcRows.length > 0;
    const policy = await this.db
      .prepare('SELECT dump_retention_seconds FROM api_keys WHERE id = ? AND deleted_at IS NULL')
      .bind(claim.key_id)
      .first<{ dump_retention_seconds: number | null }>();
    const retentionSeconds = policy?.dump_retention_seconds ?? null;
    const cutoff = retentionSeconds === null ? Number.MAX_SAFE_INTEGER : now - retentionSeconds * 1000;
    const { results: rows } = await this.db
      .prepare(
        `SELECT id FROM dump_records
         WHERE key_id = ? AND created_at < ?
         ORDER BY created_at, id LIMIT ?`,
      )
      .bind(claim.key_id, cutoff, MAINTENANCE_ROW_BATCH_SIZE)
      .all<{ id: string }>();
    if (rows.length > 0) {
      await this.db
        .prepare('DELETE FROM dump_records WHERE key_id = ? AND id IN (SELECT value FROM json_each(?))')
        .bind(claim.key_id, JSON.stringify(rows.map(row => row.id)))
        .run();
    }
    const partial = rows.length === MAINTENANCE_ROW_BATCH_SIZE;
    const oldest = partial
      ? null
      : await this.db
          .prepare('SELECT created_at FROM dump_records WHERE key_id = ? ORDER BY created_at LIMIT 1')
          .bind(claim.key_id)
          .first<{ created_at: number }>();
    const nextDueAt = partial
      ? now
      : oldest === null ? null
        : retentionSeconds === null ? 0 : oldest.created_at + retentionSeconds * 1000 + 1;
    if (nextDueAt === null) {
      await this.db
        .prepare('DELETE FROM dump_maintenance_keys WHERE claim_token = ? AND revision = ?')
        .bind(token, claim.revision)
        .run();
    }
    await this.db
      .prepare(
        `UPDATE dump_maintenance_keys
         SET due_at = CASE
               WHEN ? THEN MAX(due_at, ?)
               WHEN revision = ? AND ? IS NOT NULL THEN ?
               ELSE due_at
             END,
             claim_token = NULL,
             claimed_at = NULL
         WHERE claim_token = ?`,
      )
      .bind(partial ? 1 : 0, now, claim.revision, nextDueAt, nextDueAt, token)
      .run();
    return true;
  }
}
