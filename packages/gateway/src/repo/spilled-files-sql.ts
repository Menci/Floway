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
}
