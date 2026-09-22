import type { ScheduledMaintenanceRepo } from './types.ts';
import type { SqlDatabase } from '@floway-dev/platform';

const requireSingleRowChangeCount = (changes: number | undefined, action: string): 0 | 1 => {
  if (changes !== 0 && changes !== 1) throw new Error(`${action} reported an invalid change count: ${String(changes)}`);
  return changes;
};

export class SqlScheduledMaintenanceRepo implements ScheduledMaintenanceRepo {
  constructor(private readonly db: SqlDatabase) {}

  async tryClaim(token: string, now: number, staleClaimedBefore: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE scheduled_maintenance
         SET claim_token = ?, claimed_at = ?
         WHERE singleton = 1
           AND (claim_token IS NULL OR claimed_at < ?)`,
      )
      .bind(token, now, staleClaimedBefore)
      .run();
    return requireSingleRowChangeCount(result.meta.changes, 'Scheduled maintenance claim') === 1;
  }

  async renew(token: string, now: number): Promise<void> {
    const result = await this.db
      .prepare('UPDATE scheduled_maintenance SET claimed_at = ? WHERE singleton = 1 AND claim_token = ?')
      .bind(now, token)
      .run();
    if (requireSingleRowChangeCount(result.meta.changes, 'Scheduled maintenance renewal') !== 1) {
      throw new Error('Scheduled maintenance lease was lost before renewal');
    }
  }

  async release(token: string): Promise<void> {
    const result = await this.db
      .prepare(
        `UPDATE scheduled_maintenance
         SET claim_token = NULL, claimed_at = NULL
         WHERE singleton = 1 AND claim_token = ?`,
      )
      .bind(token)
      .run();
    requireSingleRowChangeCount(result.meta.changes, 'Scheduled maintenance release');
  }
}
