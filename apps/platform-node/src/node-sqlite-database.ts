import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

import type { SqlBindValue, SqlDatabase, SqlPreparedStatement, SqlResult } from '@floway-dev/platform';

// node:sqlite's prepared statement is synchronous and returns plain rows.
// We adapt it to the platform's async, enveloped contract. bind() returns a
// fresh statement object so two awaited binds on the same prepared statement
// never share state.
class NodeSqlitePreparedStatement implements SqlPreparedStatement {
  constructor(
    private readonly stmt: StatementSync,
    private readonly bound: readonly SqlBindValue[] = [],
  ) {}

  bind(...values: SqlBindValue[]): SqlPreparedStatement {
    return new NodeSqlitePreparedStatement(this.stmt, values);
  }

  first<T = Record<string, unknown>>(): Promise<T | null> {
    const row = this.stmt.get(...(this.bound as never[]));
    return Promise.resolve((row as T | undefined) ?? null);
  }

  all<T = Record<string, unknown>>(): Promise<SqlResult<T>> {
    const rows = this.stmt.all(...(this.bound as never[])) as T[];
    return Promise.resolve({ results: rows, success: true, meta: {} });
  }

  runSync(): SqlResult {
    const result = this.stmt.run(...(this.bound as never[]));
    return {
      results: [],
      success: true,
      meta: { changes: Number(result.changes) },
    };
  }

  run(): Promise<SqlResult> {
    return Promise.resolve(this.runSync());
  }
}

class NodeSqliteDatabase implements SqlDatabase {
  constructor(private readonly db: DatabaseSync) {}

  prepare(query: string): SqlPreparedStatement {
    return new NodeSqlitePreparedStatement(this.db.prepare(query));
  }

  // Wraps the supplied statements in a single transaction so the batch is
  // atomic. node:sqlite is fully synchronous, so we drive the batch with
  // runSync() to keep BEGIN…COMMIT inside one microtask — an `await` between
  // statements would yield, letting a concurrently-scheduled batch's BEGIN
  // run while this transaction is still open and trip
  // "cannot start a transaction within a transaction".
  batch(statements: SqlPreparedStatement[]): Promise<SqlResult[]> {
    this.db.exec('BEGIN');
    try {
      const results = statements.map(stmt => {
        if (!(stmt instanceof NodeSqlitePreparedStatement)) {
          throw new Error('NodeSqliteDatabase.batch received a statement from a different database adapter');
        }
        return stmt.runSync();
      });
      this.db.exec('COMMIT');
      return Promise.resolve(results);
    } catch (e) {
      // SQLite auto-rolls-back on a hard error class (SQLITE_FULL,
      // SQLITE_IOERR, SQLITE_BUSY, SQLITE_NOMEM, SQLITE_INTERRUPT — see
      // https://www.sqlite.org/lang_transaction.html "Response To Errors
      // Within A Transaction"); the explicit ROLLBACK then throws
      // "cannot rollback - no transaction is active" and would replace
      // the original failure on the way out. Swallow that recovery throw
      // so `throw e` always wins and the operator sees the real cause.
      try { this.db.exec('ROLLBACK'); } catch { /* txn already auto-rolled-back */ }
      throw e;
    }
  }

  exec(sql: string): Promise<unknown> {
    this.db.exec(sql);
    return Promise.resolve(undefined);
  }
}

export const createNodeSqliteDatabase = (path: string): SqlDatabase => {
  // node:sqlite throws ERR_SQLITE_ERROR ("unable to open database file") when
  // the parent directory is missing — unhelpful on a fresh deploy. Each
  // component owns its own root.
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // node:sqlite leaves foreign keys off by default; the schema relies on FK
  // enforcement, so turn it on at open.
  db.exec('PRAGMA foreign_keys = ON');
  return new NodeSqliteDatabase(db);
};
