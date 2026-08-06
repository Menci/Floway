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

// D1 lowers SQLite's compound-select ceiling from the upstream default of 500
// to 5. Deployment-bound query tests use this verifier because sql.js would
// otherwise accept SQL that D1 rejects while preparing it.
// https://github.com/cloudflare/workerd/blob/243fd41f8944c2446c46e415373b107ecb9bc789/src/workerd/util/sqlite.c%2B%2B#L1380-L1385
export const assertD1CompoundSelectLimit = (query: string) => {
  const compoundTerms = [1];
  let quote: "'" | '"' | '`' | ']' | null = null;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < query.length;) {
    const current = query[index]!;
    const next = query[index + 1];
    if (lineComment) {
      if (current === '\n') lineComment = false;
      index++;
      continue;
    }
    if (blockComment) {
      if (current === '*' && next === '/') {
        blockComment = false;
        index += 2;
      } else index++;
      continue;
    }
    if (quote !== null) {
      const closingQuote = quote === ']' ? ']' : quote;
      if (current === closingQuote) {
        if (next === closingQuote && quote !== ']') index += 2;
        else {
          quote = null;
          index++;
        }
      } else index++;
      continue;
    }
    if (current === '-' && next === '-') {
      lineComment = true;
      index += 2;
      continue;
    }
    if (current === '/' && next === '*') {
      blockComment = true;
      index += 2;
      continue;
    }
    if (current === "'" || current === '"' || current === '`' || current === '[') {
      quote = current === '[' ? ']' : current;
      index++;
      continue;
    }
    if (current === '(') {
      compoundTerms.push(1);
      index++;
      continue;
    }
    if (current === ')') {
      compoundTerms.pop();
      index++;
      continue;
    }
    if (/[A-Za-z_]/.test(current)) {
      let end = index + 1;
      while (end < query.length && /[A-Za-z0-9_]/.test(query[end]!)) end++;
      const keyword = query.slice(index, end).toUpperCase();
      if (keyword === 'UNION' || keyword === 'INTERSECT' || keyword === 'EXCEPT') {
        const depth = compoundTerms.length - 1;
        compoundTerms[depth]!++;
        if (compoundTerms[depth]! > 5) throw new Error('SQL query exceeds D1 compound SELECT limit of 5 terms');
      }
      index = end;
      continue;
    }
    index++;
  }
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
