import type { ImageCachePolicy, ImageCacheStore, SqlDatabase } from '@floway-dev/platform';

export class SqliteImageCacheStore implements ImageCacheStore {
  constructor(private readonly db: SqlDatabase, private readonly policy: ImageCachePolicy) {}

  async get(key: string): Promise<Uint8Array | null> {
    const now = Date.now();
    const row = await this.db
      .prepare('SELECT value, last_refreshed_at FROM image_cache WHERE key = ? AND expires_at > ?')
      .bind(key, now)
      .first<{ value: Uint8Array; last_refreshed_at: number }>();
    if (!row) return null;
    // Migration 0032 backfills `last_refreshed_at = 0` on rows that predate
    // the column; that maps to age = `now`, which crosses any sane threshold
    // so the next hit refreshes the row with the current timestamp via a
    // single UPDATE.
    if (now - row.last_refreshed_at >= this.policy.refreshIfOlderThanMs) {
      await this.db
        .prepare('UPDATE image_cache SET expires_at = ?, last_refreshed_at = ? WHERE key = ?')
        .bind(now + this.policy.ttlMs, now, key)
        .run();
    }
    return new Uint8Array(row.value);
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    const now = Date.now();
    await this.db
      .prepare(
        'INSERT INTO image_cache (key, value, expires_at, last_refreshed_at) VALUES (?, ?, ?, ?) '
        + 'ON CONFLICT (key) DO UPDATE SET '
        + 'value = excluded.value, expires_at = excluded.expires_at, last_refreshed_at = excluded.last_refreshed_at',
      )
      .bind(key, value, now + this.policy.ttlMs, now)
      .run();
  }

  async sweepExpired(now: number): Promise<void> {
    await this.db.prepare('DELETE FROM image_cache WHERE expires_at <= ?').bind(now).run();
  }
}
