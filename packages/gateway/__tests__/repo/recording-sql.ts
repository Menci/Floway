import type { SqlBindValue, SqlDatabase, SqlPreparedStatement } from '@floway-dev/platform';

export interface CompletedStatement {
  query: string;
  binds: readonly SqlBindValue[];
  resultCount: number;
}

export const recordCompletedStatements = (db: SqlDatabase, completed: CompletedStatement[]): SqlDatabase => {
  const wrap = (
    queryText: string,
    statement: SqlPreparedStatement,
    binds: readonly SqlBindValue[],
  ): SqlPreparedStatement => ({
    bind: (...values) => wrap(queryText, statement.bind(...values), values),
    first: () => statement.first(),
    all: async <T = Record<string, unknown>>() => {
      const result = await statement.all<T>();
      completed.push({ query: queryText, binds, resultCount: result.results.length });
      return result;
    },
    run: () => statement.run(),
  });
  return {
    prepare: queryText => wrap(queryText, db.prepare(queryText), []),
    exec: sql => db.exec(sql),
  };
};
