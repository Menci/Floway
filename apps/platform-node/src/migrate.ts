import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { migrationsDir } from '@floway-dev/gateway/migrations-dir';
import type { SqlDatabase } from '@floway-dev/platform';

const DEFAULT_MIGRATIONS_DIR = fileURLToPath(migrationsDir);

// Applies every pending migration, recording each one's name in a
// `_migrations` table so reruns are no-ops. Each file's full contents go
// through SqlDatabase.exec() rather than a hand-rolled statement split,
// because the migration corpus contains:
//   * trailing comment-only chunks that a `;` split turns into empty
//     statements, which `prepare()` rejects with "statement has been
//     finalized";
//   * `CREATE TRIGGER ... BEGIN ... END;` blocks whose embedded `;` characters
//     are part of the trigger body, which a regex split cannot honour.
// `exec()` is sqlite's native multi-statement entry point — the same one D1
// uses to apply migrations server-side.
//
// We bracket each file with our own BEGIN/COMMIT so a mid-file failure rolls
// the whole file back; without that bracket, the partial DDL from earlier
// statements would persist after a later one threw.
export const applyMigrations = async (db: SqlDatabase, dir: string = DEFAULT_MIGRATIONS_DIR): Promise<void> => {
  await db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY)');

  const appliedRows = await db.prepare('SELECT name FROM _migrations').all<{ name: string }>();
  const applied = new Set(appliedRows.results.map(r => r.name));

  const files = (await readdir(dir)).filter(f => f.endsWith('.sql')).toSorted();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(dir, file), 'utf8');

    await db.exec('BEGIN');
    try {
      await db.exec(sql);
      await db.prepare('INSERT INTO _migrations (name) VALUES (?)').bind(file).run();
      await db.exec('COMMIT');
    } catch (e) {
      // SQLite auto-rolls-back on hard errors (SQLITE_FULL, SQLITE_IOERR,
      // …) — the explicit ROLLBACK then throws "no transaction is active"
      // and would shadow the real DDL/IO failure in the operator's logs.
      // Swallow it so the genuine cause survives.
      try { await db.exec('ROLLBACK'); } catch { /* txn already auto-rolled-back */ }
      throw e;
    }
  }
};
