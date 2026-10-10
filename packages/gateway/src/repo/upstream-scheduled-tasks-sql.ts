import type { SqlDatabase } from '@floway-dev/platform';
import type { ProviderScheduledTasksRepo, ScheduledTaskClaim } from '@floway-dev/provider';

export class SqlUpstreamScheduledTasksRepo implements ProviderScheduledTasksRepo {
  constructor(private readonly db: SqlDatabase) {}

  async tryClaim(claim: ScheduledTaskClaim): Promise<number | null> {
    const row = await this.db.prepare(`
      INSERT INTO upstream_scheduled_tasks (upstream_id, task, claim_token, next_attempt_at)
      SELECT id, ?, ?, ? FROM upstreams WHERE id = ? AND enabled = 1 AND usage_refresh_interval_minutes > 0
      ON CONFLICT (upstream_id, task) DO UPDATE SET
        claim_token = excluded.claim_token, next_attempt_at = excluded.next_attempt_at
      WHERE upstream_scheduled_tasks.next_attempt_at <= ?
        AND (upstream_scheduled_tasks.failure_count > 0 OR upstream_scheduled_tasks.completed_at IS NULL
          OR upstream_scheduled_tasks.completed_at + ? <= ?)
      RETURNING failure_count
    `).bind(claim.task, claim.token, claim.nextAttemptAt, claim.upstreamId, claim.now, claim.intervalMs, claim.now)
      .first<{ failure_count: number }>();
    return row === null ? null : row.failure_count;
  }

  async finish(claim: ScheduledTaskClaim, outcome: { nextAttemptAt: number; completedAt: number | null; failureCount: number; error: string | null }): Promise<void> {
    await this.db.prepare(`
      UPDATE upstream_scheduled_tasks SET claim_token = NULL, next_attempt_at = ?, completed_at = ?, failure_count = ?, last_error = ?
      WHERE upstream_id = ? AND task = ? AND claim_token = ?
    `).bind(outcome.nextAttemptAt, outcome.completedAt, outcome.failureCount, outcome.error, claim.upstreamId, claim.task, claim.token).run();
  }
}
