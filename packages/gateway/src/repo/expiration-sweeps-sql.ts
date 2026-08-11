import type {
  ExpirationDomain,
  ExpirationSweepClaim,
  ExpirationSweepCompletion,
  ExpirationSweepsRepo,
} from './types.ts';
import { decodeDumpBodyDescriptor } from '../dump/storage-codec.ts';
import type { SqlDatabase } from '@floway-dev/platform';

interface CleanupBackfillSourceState {
  source: string;
  next_rowid: number;
}

interface BackfillRow {
  rowid: number;
  key_id: string;
}

interface DumpBackfillRow extends BackfillRow {
  id: string;
  request_body_descriptor: string | null;
  response_body_descriptor: string | null;
}

interface DumpFileOwner {
  fileKey: string;
  ownerKind: 'dump-request' | 'dump-response';
  keyId: string;
  recordId: string;
}

const CLEANUP_BACKFILL_SOURCES = {
  dump_records: { domain: 'dumps', keyColumn: 'key_id' },
  responses_items: { domain: 'responses', keyColumn: 'api_key_id' },
  responses_snapshots: { domain: 'responses', keyColumn: 'api_key_id' },
} as const satisfies Record<string, { domain: ExpirationDomain; keyColumn: string }>;

type CleanupBackfillSource = keyof typeof CLEANUP_BACKFILL_SOURCES;

const isCleanupBackfillSource = (source: string): source is CleanupBackfillSource => source in CLEANUP_BACKFILL_SOURCES;

export class SqlExpirationSweepsRepo implements ExpirationSweepsRepo {
  constructor(private readonly db: SqlDatabase) {}

  async backfillCleanupTracking(limit: number): Promise<void> {
    if (!Number.isInteger(limit) || limit <= 0) throw new Error(`Retention cleanup backfill limit must be positive: ${limit}`);
    const { results: sources } = await this.db
      .prepare('SELECT source, next_rowid FROM cleanup_backfills WHERE complete = 0 ORDER BY source')
      .all<CleanupBackfillSourceState>();
    let remaining = limit;
    for (let index = 0; index < sources.length && remaining > 0; index += 1) {
      const source = sources[index];
      if (!isCleanupBackfillSource(source.source)) throw new Error(`Unknown retention cleanup backfill source: ${source.source}`);
      const sourceLimit = Math.max(1, Math.floor(remaining / (sources.length - index)));
      const consumed = await this.backfillCleanupSource(source.source, source.next_rowid, sourceLimit);
      remaining -= consumed;
    }
  }

  private async backfillCleanupSource(source: CleanupBackfillSource, cursor: number, limit: number): Promise<number> {
    const config = CLEANUP_BACKFILL_SOURCES[source];
    const descriptorColumns = source === 'dump_records'
      ? ', id, request_body_descriptor, response_body_descriptor'
      : '';
    const { results } = await this.db
      .prepare(
        `SELECT rowid, ${config.keyColumn} AS key_id${descriptorColumns}
         FROM ${source} WHERE rowid > ? ORDER BY rowid LIMIT ?`,
      )
      .bind(cursor, limit)
      .all<DumpBackfillRow>();
    if (results.length > 0) {
      const keyIds = [...new Set(results.map(row => row.key_id))];
      await this.db
        .prepare(
          `INSERT INTO expiration_sweeps (domain, key_id, due_at)
           SELECT ?, value, 0 FROM json_each(?)
           WHERE true
           ON CONFLICT (domain, key_id) DO UPDATE SET
             due_at = 0,
             revision = expiration_sweeps.revision + 1
           WHERE expiration_sweeps.claim_token IS NOT NULL
              OR expiration_sweeps.due_at > 0`,
        )
        .bind(config.domain, JSON.stringify(keyIds))
        .run();
      if (source === 'dump_records') await this.registerDumpFiles(results);
    }
    const complete = results.length < limit;
    const nextRowId = results.at(-1)?.rowid ?? cursor;
    await this.db
      .prepare(
        `UPDATE cleanup_backfills
         SET next_rowid = MAX(next_rowid, ?), complete = MAX(complete, ?)
         WHERE source = ?`,
      )
      .bind(nextRowId, complete ? 1 : 0, source)
      .run();
    return results.length;
  }

  private async registerDumpFiles(rows: readonly DumpBackfillRow[]): Promise<void> {
    const files: DumpFileOwner[] = rows.flatMap(row => [
      ...(row.request_body_descriptor === null ? [] : [{
        fileKey: decodeDumpBodyDescriptor(
          row.request_body_descriptor,
          `dump record ${row.key_id}/${row.id} request body descriptor during expiration backfill`,
        ).key,
        ownerKind: 'dump-request' as const,
        keyId: row.key_id,
        recordId: row.id,
      }]),
      ...(row.response_body_descriptor === null ? [] : [{
        fileKey: decodeDumpBodyDescriptor(
          row.response_body_descriptor,
          `dump record ${row.key_id}/${row.id} response body descriptor during expiration backfill`,
        ).key,
        ownerKind: 'dump-response' as const,
        keyId: row.key_id,
        recordId: row.id,
      }]),
    ]);
    if (files.length === 0) return;
    await this.db
      .prepare(
        `INSERT INTO spilled_files (file_key, owner_kind, owner_key, state, collect_after)
         SELECT
           json_extract(value, '$.fileKey'),
           json_extract(value, '$.ownerKind'),
           json_array(records.key_id, records.id),
           'owned',
           NULL
         FROM json_each(?) AS incoming
         JOIN dump_records AS records
           ON records.key_id = json_extract(incoming.value, '$.keyId')
          AND records.id = json_extract(incoming.value, '$.recordId')
         WHERE (
           json_extract(incoming.value, '$.ownerKind') = 'dump-request'
           AND json_extract(records.request_body_descriptor, '$.key') = json_extract(incoming.value, '$.fileKey')
         ) OR (
           json_extract(incoming.value, '$.ownerKind') = 'dump-response'
           AND json_extract(records.response_body_descriptor, '$.key') = json_extract(incoming.value, '$.fileKey')
         )
         ON CONFLICT (file_key) DO NOTHING`,
      )
      .bind(JSON.stringify(files))
      .run();
  }

  async schedule(domain: ExpirationDomain, keyId: string, dueAt: number): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO expiration_sweeps (domain, key_id, due_at) VALUES (?, ?, ?)
         ON CONFLICT (domain, key_id) DO UPDATE SET
           due_at = MIN(expiration_sweeps.due_at, excluded.due_at),
           revision = expiration_sweeps.revision + 1`,
      )
      .bind(domain, keyId, dueAt)
      .run();
  }

  async claim(token: string, now: number, staleClaimedBefore: number): Promise<ExpirationSweepClaim | null> {
    await this.db
      .prepare(
        `UPDATE expiration_sweeps
         SET claim_token = ?, claimed_at = ?
         WHERE (domain, key_id) = (
           SELECT domain, key_id FROM expiration_sweeps
           WHERE due_at <= ? AND (claim_token IS NULL OR claimed_at < ?)
           ORDER BY due_at, key_id, domain
           LIMIT 1
         )`,
      )
      .bind(token, now, now, staleClaimedBefore)
      .run();
    const row = await this.db
      .prepare('SELECT domain, key_id, revision FROM expiration_sweeps WHERE claim_token = ?')
      .bind(token)
      .first<{ domain: ExpirationDomain; key_id: string; revision: number }>();
    return row === null ? null : { domain: row.domain, keyId: row.key_id, revision: row.revision };
  }

  async complete(token: string, expectedRevision: number, completion: ExpirationSweepCompletion): Promise<void> {
    if (completion.kind === 'drained' && completion.nextDueAt === null) {
      await this.db
        .prepare('DELETE FROM expiration_sweeps WHERE claim_token = ? AND revision = ?')
        .bind(token, expectedRevision)
        .run();
      await this.db
        .prepare('UPDATE expiration_sweeps SET claim_token = NULL, claimed_at = NULL WHERE claim_token = ?')
        .bind(token)
        .run();
      return;
    }
    const nextDueAt = completion.kind === 'partial' ? completion.retryAt : completion.nextDueAt;
    if (nextDueAt === null) throw new Error('expiration sweep completion is missing its next due time');
    await this.db
      .prepare(
        `UPDATE expiration_sweeps
         SET due_at = CASE WHEN revision = ? OR ? THEN ? ELSE MIN(due_at, ?) END,
             claim_token = NULL,
             claimed_at = NULL
         WHERE claim_token = ?`,
      )
      .bind(expectedRevision, completion.kind === 'partial' ? 1 : 0, nextDueAt, nextDueAt, token)
      .run();
  }
}
