import type { SqlDatabase, SqlPreparedStatement } from '@floway-dev/platform';

export const runStatements = async (db: SqlDatabase, statements: SqlPreparedStatement[]): Promise<void> => {
  if (statements.length === 0) return;
  if (db.batch) {
    await db.batch(statements);
    return;
  }
  for (const statement of statements) await statement.run();
};
