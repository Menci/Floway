import type {
  ExpirationDomain,
  ExpirationSweepClaim,
  ExpirationSweepCompletion,
  ExpirationSweepsRepo,
} from './types.ts';
import type { SqlDatabase } from '@floway-dev/platform';

export class SqlExpirationSweepsRepo implements ExpirationSweepsRepo {
  constructor(private readonly db: SqlDatabase) {}

  async backfillDumpKeys(limit: number): Promise<void> {
    const state = await this.db
      .prepare('SELECT next_dump_rowid, complete FROM expiration_sweep_backfill WHERE id = 1')
      .first<{ next_dump_rowid: number; complete: number }>();
    if (state === null) throw new Error('expiration_sweep_backfill singleton row missing');
    if (state.complete !== 0) return;

    const { results } = await this.db
      .prepare('SELECT rowid, key_id FROM dump_records WHERE rowid > ? ORDER BY rowid LIMIT ?')
      .bind(state.next_dump_rowid, limit)
      .all<{ rowid: number; key_id: string }>();
    if (results.length > 0) {
      const keyIds = [...new Set(results.map(row => row.key_id))];
      await this.db
        .prepare(
          `INSERT INTO expiration_sweeps (domain, key_id, due_at)
           SELECT 'dumps', value, 0 FROM json_each(?)
           WHERE true
           ON CONFLICT (domain, key_id) DO NOTHING`,
        )
        .bind(JSON.stringify(keyIds))
        .run();
    }
    const complete = results.length < limit;
    const nextRowId = results.at(-1)?.rowid ?? state.next_dump_rowid;
    await this.db
      .prepare('UPDATE expiration_sweep_backfill SET next_dump_rowid = ?, complete = ? WHERE id = 1')
      .bind(nextRowId, complete ? 1 : 0)
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
