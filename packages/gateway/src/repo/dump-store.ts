import { DUMP_FILE_PREFIX, SPILLED_FILE_STAGE_GRACE_MS } from './spilled-files-policy.ts';
import { parseUpstreamHue, parseUpstreamKind } from './upstream-parse.ts';
import { dumpCaptureEnvelopeSchema } from '../dump/schemas.ts';
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
  DumpKeyRef,
  DumpMetadata,
  DumpRecordId,
  DumpUpstreamRef,
  DumpWriteRecord,
  PreparedDumpRequestBody,
  StoredDumpRecord,
  StoredDumpRequest,
  StoredDumpResponse,
  StoredDumpResponseBody,
  StoredDumpUpstreamResponse,
} from '../dump/types.ts';
import { upstreamResponseToWire } from '../dump/wire.ts';
import { gunzipBytes, gzipBytes } from '../shared/gzip.ts';
import type { FileStore, SqlDatabase } from '@floway-dev/platform';
import { decodeForgivingBase64 } from '@floway-dev/protocols/common';

// Bodies live at `dumps/v1/{keyId}/{YYYYMMDDHH}/{recordId}-{uniqueSuffix}.{req|resp}.gz`.
// The hour segment remains useful for operator inspection; lifecycle and
// collection are driven by the shared spilled_files registry.

const HOUR_MS = 60 * 60 * 1000;

interface DumpRow {
  id: string;
  created_at: number;
  key_id: string;
  key_name: string;
  key_suffix: string;
  upstream_id: string | null;
  upstream_name: string | null;
  upstream_kind: string | null;
  upstream_hue: number | null;
  meta_json: string;
  request_headers_json: string;
  response_headers_json: string | null;
  request_body_descriptor: string | null;
  response_body_descriptor: string | null;
  response_upstream_body_descriptor: string | null;
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

const hydrateKey = (row: Pick<DumpRow, 'key_id' | 'key_name' | 'key_suffix'>): DumpKeyRef => ({
  id: row.key_id,
  name: row.key_name,
  suffix: row.key_suffix,
});

// Decoding a row is where a list page's cost actually is: the metadata JSON
// goes back through its zod schema. The merged page sorts up to one page per
// key and returns only `limit`, so it decodes after the cut.
const hydrateListedDumpRow = (row: DumpRow): DumpMetadata => ({
  ...decodePersistedDumpMetadata(row.meta_json, `dump record ${row.id} metadata`),
  key: hydrateKey(row),
  upstream: hydrateUpstream(row),
});

// The request log's one search box covers identity, route, model, upstream and key
// name. The key name is joined in, so a merged row can be narrowed without
// knowing which key captured it; the live stream applies the same field.
// https://www.sqlite.org/lang_corefunc.html#instr
const SEARCH_EXPRESSION = `instr(lower(d.id || ' ' || coalesce(json_extract(d.meta_json, '$.path'), '') || ' ' || coalesce(json_extract(d.meta_json, '$.model'), '') || ' ' || coalesce(u.name, '') || ' ' || coalesce(k.name, '') || ' ' || coalesce(json_extract(d.meta_json, '$.status'), '') || ' ' || coalesce(json_extract(d.meta_json, '$.error.reason'), json_extract(d.meta_json, '$.error.kind'), '')), lower(?)) > 0`;

const keyIdList = (keyIds: readonly string[]): string => JSON.stringify(keyIds);

// A retired key's rows are unreadable even before its physical sweep: the same
// join the single-key reads already relied on.
const recordJoins = 'LEFT JOIN upstreams u ON u.id = d.upstream_id '
  + 'JOIN api_keys k ON k.id = d.key_id AND k.deleted_at IS NULL AND k.dump_retention_seconds IS NOT NULL';

const retentionCondition = 'd.created_at >= ? - k.dump_retention_seconds * 1000';

const failureCondition = "(json_type(d.meta_json, '$.error') != 'null' OR json_extract(d.meta_json, '$.status') >= 400)";

// The key segment of a list row; `substr` cuts the display tail in SQL so the
// raw key column is never read out.
const recordSelect = `SELECT d.id, d.key_id, k.name AS key_name, substr(k.key, -4) AS key_suffix, d.meta_json, d.upstream_id, u.name AS upstream_name, u.provider AS upstream_kind, u.hue AS upstream_hue, d.created_at FROM dump_records d ${recordJoins}`;

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

const fetchBody = async (files: FileStore, descriptor: DumpBodyDescriptor): Promise<Uint8Array> => {
  const gz = await files.get(descriptor.key);
  if (!gz) throw new Error(`dump body missing for key=${descriptor.key}`);
  return await gunzipBytes(gz);
};

export class FileDumpStore implements DumpStore {
  constructor(private readonly db: SqlDatabase, private readonly files: FileStore) {}

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
    const beforeTs = opts.before === undefined ? null : await this.beforeTimestamp([keyId], opts.before);
    if (opts.before !== undefined && beforeTs === null) return [];
    return (await this.listKeyPage(keyId, opts, beforeTs)).map(row => hydrateListedDumpRow(row));
  }

  // One page per key, merged in memory. `dump_records` is indexed by
  // `(key_id, created_at DESC)`, so a single `key_id IN (...)` scan reads every
  // retained row of every key before it can sort and cut — linear in the
  // retention window rather than in the page size. Each key's own index seek
  // touches at most `limit` rows.
  async listAll(keyIds: readonly string[], opts: DumpListOptions): Promise<DumpMetadata[]> {
    if (keyIds.length === 0) return [];
    // The cursor is global, so it is resolved once across the whole scope and
    // every key's query takes the same (created_at, id) bound. A cursor that
    // names a record outside the scope cannot order this page.
    const beforeTs = opts.before === undefined ? null : await this.beforeTimestamp(keyIds, opts.before);
    if (opts.before !== undefined && beforeTs === null) return [];
    const pages = await Promise.all(keyIds.map(keyId => this.listKeyPage(keyId, opts, beforeTs)));
    // Ordering happens on the raw rows: the merged candidate set is up to K
    // pages, and only `limit` of them are ever decoded.
    return pages
      .flat()
      .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
      .slice(0, opts.limit)
      .map(row => hydrateListedDumpRow(row));
  }

  private async beforeTimestamp(keyIds: readonly string[], before: DumpRecordId): Promise<number | null> {
    const row = await this.db.prepare(
      'SELECT created_at FROM dump_records WHERE id = ? AND key_id IN (SELECT CAST(value AS TEXT) FROM json_each(?))',
    ).bind(before, keyIdList(keyIds)).first<{ created_at: number }>();
    return row?.created_at ?? null;
  }

  private async listKeyPage(keyId: string, opts: DumpListOptions, beforeTs: number | null): Promise<DumpRow[]> {
    // Newest-first with a compound (created_at, id) cursor so rows sharing a
    // millisecond still page deterministically — ULID lex order matches
    // creation order within the ms.
    const conditions = ['d.key_id = ?', retentionCondition];
    const parameters: (string | number)[] = [keyId, Date.now()];
    if (beforeTs !== null) {
      conditions.push('(d.created_at < ? OR (d.created_at = ? AND d.id < ?))');
      parameters.push(beforeTs, beforeTs, opts.before!);
    }
    if (opts.failures) conditions.push(failureCondition);
    if (opts.q) {
      conditions.push(SEARCH_EXPRESSION);
      parameters.push(opts.q);
    }
    const stmt = this.db.prepare(`${recordSelect} WHERE ${conditions.join(' AND ')} ORDER BY d.created_at DESC, d.id DESC LIMIT ?`).bind(...parameters, opts.limit);
    const { results } = await stmt.all<DumpRow>();
    return results;
  }

  async get(keyId: string, recordId: DumpRecordId): Promise<StoredDumpRecord | null> {
    return await this.getWhere([keyId], recordId);
  }

  async getAny(keyIds: readonly string[], recordId: DumpRecordId): Promise<StoredDumpRecord | null> {
    return await this.getWhere(keyIds, recordId);
  }

  private async getWhere(keyIds: readonly string[], recordId: DumpRecordId): Promise<StoredDumpRecord | null> {
    if (keyIds.length === 0) return null;
    const row = await this.db.prepare(
      'SELECT d.id, d.key_id, k.name AS key_name, substr(k.key, -4) AS key_suffix, d.upstream_id, u.name AS upstream_name, u.provider AS upstream_kind, u.hue AS upstream_hue, '
      + 'd.meta_json, d.request_headers_json, d.response_headers_json, d.request_body_descriptor, d.response_body_descriptor, d.response_upstream_body_descriptor '
      + `FROM dump_records d ${recordJoins} `
      + `WHERE d.id = ? AND d.key_id IN (SELECT CAST(value AS TEXT) FROM json_each(?)) AND ${retentionCondition}`,
    ).bind(recordId, keyIdList(keyIds), Date.now()).first<DumpRow>();
    if (!row) return null;

    const meta: DumpMetadata = {
      ...decodePersistedDumpMetadata(row.meta_json, `dump record ${recordId} metadata`),
      key: hydrateKey(row),
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
    const upstreamDescriptor = row.response_upstream_body_descriptor === null
      ? null
      : decodeDumpBodyDescriptor(row.response_upstream_body_descriptor, `dump record ${recordId} upstream response body descriptor`);

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

    // The pre-translation upstream body, when a descriptor was persisted.
    // Same rehydration rules as the downstream body; absent on native turns
    // and on records written before the upstream column existed (NULL).
    let upstream: StoredDumpUpstreamResponse | undefined;
    let capture: StoredDumpRecord['capture'];
    if (upstreamDescriptor?.type === 'capture') {
      const envelope = dumpCaptureEnvelopeSchema.parse(JSON.parse(new TextDecoder().decode(await fetchBody(this.files, upstreamDescriptor))));
      capture = envelope.capture;
      const stored = envelope.upstream;
      if (stored !== undefined) {
        upstream = {
          ...stored, body: stored.body.type === 'bytes'
            ? { type: 'bytes', body: stored.body.body.encoding === 'utf8' ? new TextEncoder().encode(stored.body.body.data) : decodeForgivingBase64(stored.body.body.data) }
            : stored.body,
        };
      }
    } else if (upstreamDescriptor !== null) {
      let upstreamBody: StoredDumpResponseBody;
      if (upstreamDescriptor.type === 'events') {
        const text = new TextDecoder().decode(await fetchBody(this.files, upstreamDescriptor));
        upstreamBody = {
          type: 'stream',
          events: decodeDumpStreamEvents(text, `dump record ${recordId} upstream response events at key=${upstreamDescriptor.key}`),
        };
      } else {
        upstreamBody = { type: 'bytes', body: await fetchBody(this.files, upstreamDescriptor) };
      }
      // Upstream headers/status were not persisted separately (the bytes case
      // carries an api-error envelope the dashboard renders as a body, not as
      // a headered response). An empty header set + null status is the honest
      // representation for what was captured.
      upstream = { status: null, headers: [], body: upstreamBody };
    }

    const response: StoredDumpResponse = {
      status: meta.status,
      headers: responseHeaders ?? [],
      body: responseBody,
      ...(upstream !== undefined ? { upstream } : {}),
    };
    return { meta, request, response, ...(capture === undefined ? {} : { capture }) };
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
    // A null lookup key skips the dump index seek when retention is active.
    const inactive = await this.db
      .prepare(
        `DELETE FROM dump_records WHERE rowid IN (
           SELECT records.rowid FROM dump_records AS records
           WHERE records.key_id = (
             SELECT ? WHERE NOT EXISTS (
               SELECT 1 FROM api_keys
               WHERE api_keys.id = ?
                 AND api_keys.deleted_at IS NULL
                 AND api_keys.dump_retention_seconds IS NOT NULL
             )
           )
           ORDER BY records.created_at, records.rowid
           LIMIT ?
         )
         RETURNING rowid`,
      )
      .bind(keyId, keyId, limit - activeDeleted)
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
