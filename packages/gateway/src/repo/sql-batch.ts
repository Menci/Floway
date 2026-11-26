import type { SqlDatabase, SqlPreparedStatement, SqlResult } from '@floway-dev/platform';

export const runStatements = async (db: SqlDatabase, statements: SqlPreparedStatement[]): Promise<SqlResult[]> => {
  if (statements.length === 0) return [];
  if (db.batch) return await db.batch(statements);
  const results: SqlResult[] = [];
  for (const statement of statements) results.push(await statement.run());
  return results;
};
