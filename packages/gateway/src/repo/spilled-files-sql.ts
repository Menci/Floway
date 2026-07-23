import type { SpilledFilesRepo } from './types.ts';
import type { SqlDatabase } from '@floway-dev/platform';

export class SqlSpilledFilesRepo implements SpilledFilesRepo {
  constructor(private readonly db: SqlDatabase) {}

  async claimCollectible(token: string, now: number, staleClaimedBefore: number, limit: number): Promise<string[]> {
    await this.db
      .prepare(
        `UPDATE spilled_files
         SET claim_token = ?, claimed_at = ?
         WHERE file_key IN (
           SELECT file_key FROM spilled_files
           WHERE state != 'owned'
             AND collect_after <= ?
             AND (claim_token IS NULL OR claimed_at < ?)
           ORDER BY collect_after, file_key
           LIMIT ?
         )`,
      )
      .bind(token, now, now, staleClaimedBefore, limit)
      .run();
    const { results } = await this.db
      .prepare('SELECT file_key FROM spilled_files WHERE claim_token = ? ORDER BY file_key')
      .bind(token)
      .all<{ file_key: string }>();
    return results.map(row => row.file_key);
  }

  async acknowledge(token: string): Promise<number> {
    const result = await this.db.prepare('DELETE FROM spilled_files WHERE claim_token = ?').bind(token).run();
    return result.meta.changes ?? 0;
  }

  async claimInventory(
    token: string,
    prefix: string,
    now: number,
    staleClaimedBefore: number,
  ): Promise<{ cursor: string | null; revision: number } | null> {
    await this.db
      .prepare(
        `UPDATE spilled_file_inventories
         SET claim_token = ?, claimed_at = ?
         WHERE prefix = ? AND (claim_token IS NULL OR claimed_at < ?)`,
      )
      .bind(token, now, prefix, staleClaimedBefore)
      .run();
    return await this.db
      .prepare('SELECT cursor, revision FROM spilled_file_inventories WHERE prefix = ? AND claim_token = ?')
      .bind(prefix, token)
      .first<{ cursor: string | null; revision: number }>();
  }

  async completeInventory(
    token: string,
    prefix: string,
    expectedRevision: number,
    fileKeys: readonly string[],
    nextCursor: string | null,
    collectAfter: number,
  ): Promise<boolean> {
    if (fileKeys.length > 0) {
      await this.db
        .prepare(
          `INSERT INTO spilled_files (file_key, owner_kind, owner_key, state, collect_after)
           SELECT value, 'inventory', json_array(?, value), 'retired', ?
           FROM json_each(?)
           WHERE true
           ON CONFLICT (file_key) DO NOTHING`,
        )
        .bind(prefix, collectAfter, JSON.stringify(fileKeys))
        .run();
    }
    const result = await this.db
      .prepare(
        `UPDATE spilled_file_inventories
         SET cursor = ?,
             passes = passes + CASE WHEN ? IS NULL THEN 1 ELSE 0 END,
             revision = revision + 1,
             claim_token = NULL,
             claimed_at = NULL
         WHERE prefix = ? AND claim_token = ? AND revision = ?`,
      )
      .bind(nextCursor, nextCursor, prefix, token, expectedRevision)
      .run();
    return (result.meta.changes ?? 0) === 1;
  }

  async releaseInventory(token: string): Promise<void> {
    await this.db
      .prepare('UPDATE spilled_file_inventories SET claim_token = NULL, claimed_at = NULL WHERE claim_token = ?')
      .bind(token)
      .run();
  }
}
