import initSqlJs from 'sql.js';
import type { SqlJsDatabase } from 'sql.js';

import type { SqlBindValue, SqlDatabase, SqlPreparedStatement, SqlResult } from '@floway-dev/platform';

export type { SqlJsDatabase };

export const migrationSqlByFilename = Object.entries(import.meta.glob('../../migrations/*.sql', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)
  .map(([path, sql]) => [path.slice(path.lastIndexOf('/') + 1), sql] as const)
  .toSorted(([a], [b]) => a.localeCompare(b));

// Both deployment targets build SQLite with SQLITE_ENABLE_MATH_FUNCTIONS, which
// spells exponentiation `pow`. sql.js instead carries SQLite's contrib
// extension-functions set, which spells the same operation `power` and is the
// spelling D1's authorizer rejects, so a migration cannot be written against
// it. Register the name the targets have rather than the name this build does.
// https://github.com/cloudflare/workerd/blob/05e868985ed7496ee7e162c22bce4f8a3f206038/src/workerd/util/sqlite.c%2B%2B#L450-L476
const registerTargetMathFunctions = (db: SqlJsDatabase) => {
  db.create_function('pow', ((base: number, exponent: number) => base ** exponent) as (...args: never[]) => unknown);
};

// Lets a test that drove the migrations itself — seeding rows between two of
// them — read the result back through the production repository.
export const wrapSqlJsDatabase = (db: SqlJsDatabase): SqlDatabase => new SqlJsSqlDatabase(db);

// The only way to open a sql.js database here, so no test can reach one that
// is missing a function the deployment targets have.
export const createSqlJsDatabase = async (): Promise<SqlJsDatabase> => {
  const db = new (await initSqlJs()).Database();
  registerTargetMathFunctions(db);
  return db;
};

export const createSqliteTestDb = async (): Promise<SqlDatabase> => {
  const db = await createSqlJsDatabase();
  for (const [, sql] of migrationSqlByFilename) db.run(sql);
  return wrapSqlJsDatabase(db);
};

// sql.js binds through JavaScript and happily takes values neither deployment
// target accepts, so it would pass a statement that fails in production. Reject
// anything outside the contract's own union here instead.
const assertBindable = (values: readonly SqlBindValue[]): readonly SqlBindValue[] => {
  values.forEach((value, index) => {
    if (value === null || typeof value === 'number' || typeof value === 'string' || value instanceof Uint8Array) return;
    throw new TypeError(`SQL parameter ${index + 1} is a ${typeof value}, which no deployment target can bind`);
  });
  return values;
};

class SqlJsPreparedStatement implements SqlPreparedStatement {
  constructor(private readonly db: SqlJsDatabase, private readonly query: string, private readonly bound: readonly SqlBindValue[] = []) {}

  bind(...values: SqlBindValue[]): SqlPreparedStatement {
    return new SqlJsPreparedStatement(this.db, this.query, assertBindable(values));
  }

  first<T = Record<string, unknown>>(): Promise<T | null> {
    const [result] = this.db.exec(this.query, this.bound as unknown[]);
    if (!result || result.values.length === 0) return Promise.resolve(null);
    const row = Object.fromEntries(result.columns.map((column, index) => [column, result.values[0][index]])) as T;
    return Promise.resolve(row);
  }

  all<T = Record<string, unknown>>(): Promise<SqlResult<T>> {
    const [result] = this.db.exec(this.query, this.bound as unknown[]);
    if (!result) return Promise.resolve({ results: [], success: true, meta: {} });
    const results = result.values.map(values => Object.fromEntries(result.columns.map((column, index) => [column, values[index]])) as T);
    return Promise.resolve({ results, success: true, meta: {} });
  }

  run(): Promise<SqlResult> {
    // sql.js's `run()` does not surface `changes`. Read it back via
    // `SELECT changes()` so the CAS path in saveState gets an accurate count.
    this.db.run(this.query, this.bound as unknown[]);
    const [changesResult] = this.db.exec('SELECT changes() AS changes');
    const changes = Number(changesResult.values[0][0]);
    return Promise.resolve({ results: [], success: true, meta: { changes } });
  }
}

class SqlJsSqlDatabase implements SqlDatabase {
  constructor(private readonly db: SqlJsDatabase) {}

  prepare(query: string): SqlPreparedStatement {
    return new SqlJsPreparedStatement(this.db, query);
  }

  exec(sql: string): Promise<unknown> {
    this.db.exec(sql);
    return Promise.resolve(undefined);
  }
}
