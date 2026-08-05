import type { SqlBindValue, SqlDatabase, SqlPreparedStatement } from '@floway-dev/platform';

export interface CapturedStatement {
  query: string;
  binds: readonly SqlBindValue[];
}

export interface CompletedStatement extends CapturedStatement {
  resultCount: number;
}

export const recordBoundStatements = (db: SqlDatabase, captured: CapturedStatement[]): SqlDatabase => ({
  prepare: queryText => {
    const statement = db.prepare(queryText);
    return {
      bind: (...binds) => {
        captured.push({ query: queryText, binds });
        return statement.bind(...binds);
      },
      first: () => statement.first(),
      all: () => statement.all(),
      run: () => statement.run(),
    };
  },
  exec: sql => db.exec(sql),
});

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
