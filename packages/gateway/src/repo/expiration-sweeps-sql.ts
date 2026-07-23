import type {
  ExpirationDomain,
  ExpirationOwnerBackfillState,
  ExpirationSweepClaim,
  ExpirationSweepCompletion,
  ExpirationSweepsRepo,
} from './types.ts';
import type { SqlDatabase } from '@floway-dev/platform';

interface BackfillSourceState {
  source: string;
  next_rowid: number;
}

interface BackfillOwnerRow {
  rowid: number;
  key_id: string;
}

interface DumpBackfillOwnerRow extends BackfillOwnerRow {
  id: string;
  request_body_descriptor: string | null;
  response_body_descriptor: string | null;
}

interface DumpFileOwner {
  fileKey: string;
  ownerKind: 'dump-request' | 'dump-response';
  ownerKey: [string, string];
}

const BACKFILL_SOURCES = {
  dump_records: { domain: 'dumps', keyColumn: 'key_id' },
  responses_items: { domain: 'responses', keyColumn: 'api_key_id' },
  responses_snapshots: { domain: 'responses', keyColumn: 'api_key_id' },
} as const satisfies Record<string, { domain: ExpirationDomain; keyColumn: string }>;

type BackfillSource = keyof typeof BACKFILL_SOURCES;

const isBackfillSource = (source: string): source is BackfillSource => source in BACKFILL_SOURCES;

const dumpFileKey = (descriptor: string, source: string): string => {
  const parsed: unknown = JSON.parse(descriptor);
  if (typeof parsed !== 'object' || parsed === null || !('key' in parsed) || typeof parsed.key !== 'string') {
    throw new Error(`Dump ${source} descriptor is missing its file key`);
  }
  return parsed.key;
};

export class SqlExpirationSweepsRepo implements ExpirationSweepsRepo {
  constructor(private readonly db: SqlDatabase) {}

  async backfillOwners(limit: number): Promise<ExpirationOwnerBackfillState> {
    if (!Number.isInteger(limit) || limit <= 0) throw new Error(`Expiration owner backfill limit must be positive: ${limit}`);
    const { results: sources } = await this.db
      .prepare('SELECT source, next_rowid FROM expiration_sweep_backfills WHERE complete = 0 ORDER BY source')
      .all<BackfillSourceState>();
    let remaining = limit;
    for (let index = 0; index < sources.length && remaining > 0; index += 1) {
      const source = sources[index];
      if (!isBackfillSource(source.source)) throw new Error(`Unknown expiration owner backfill source: ${source.source}`);
      const sourceLimit = Math.max(1, Math.floor(remaining / (sources.length - index)));
      const consumed = await this.backfillSource(source.source, source.next_rowid, sourceLimit);
      remaining -= consumed;
    }
    const { results: states } = await this.db
      .prepare('SELECT source, complete FROM expiration_sweep_backfills')
      .all<{ source: string; complete: number }>();
    const dumpRecords = states.find(state => state.source === 'dump_records');
    if (dumpRecords === undefined) throw new Error('dump_records expiration owner backfill state missing');
    return {
      dumpRecordsComplete: dumpRecords.complete !== 0,
    };
  }

  private async backfillSource(source: BackfillSource, cursor: number, limit: number): Promise<number> {
    const config = BACKFILL_SOURCES[source];
    const descriptorColumns = source === 'dump_records'
      ? ', id, request_body_descriptor, response_body_descriptor'
      : '';
    const { results } = await this.db
      .prepare(
        `SELECT rowid, ${config.keyColumn} AS key_id${descriptorColumns}
         FROM ${source} WHERE rowid > ? ORDER BY rowid LIMIT ?`,
      )
      .bind(cursor, limit)
      .all<DumpBackfillOwnerRow>();
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
        `UPDATE expiration_sweep_backfills
         SET next_rowid = MAX(next_rowid, ?), complete = MAX(complete, ?)
         WHERE source = ?`,
      )
      .bind(nextRowId, complete ? 1 : 0, source)
      .run();
    return results.length;
  }

  private async registerDumpFiles(rows: readonly DumpBackfillOwnerRow[]): Promise<void> {
    const files: DumpFileOwner[] = rows.flatMap(row => [
      ...(row.request_body_descriptor === null ? [] : [{
        fileKey: dumpFileKey(row.request_body_descriptor, 'request body'),
        ownerKind: 'dump-request' as const,
        ownerKey: [row.key_id, row.id] as [string, string],
      }]),
      ...(row.response_body_descriptor === null ? [] : [{
        fileKey: dumpFileKey(row.response_body_descriptor, 'response body'),
        ownerKind: 'dump-response' as const,
        ownerKey: [row.key_id, row.id] as [string, string],
      }]),
    ]);
    if (files.length === 0) return;
    await this.db
      .prepare(
        `INSERT INTO spilled_files (file_key, owner_kind, owner_key, state, collect_after)
         SELECT
           json_extract(value, '$.fileKey'),
           json_extract(value, '$.ownerKind'),
           json_extract(value, '$.ownerKey'),
           'owned',
           NULL
         FROM json_each(?)
         WHERE true
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
      .bind(expectedRevision, completion.kind === 'partial', nextDueAt, nextDueAt, token)
      .run();
  }
}
