import { expect, test, vi } from 'vitest';

import { assertD1CompoundSelectLimit, createSqliteTestDb, mapRunChangeCount } from './test-sqlite.ts';
import type { SqlDatabase, SqlPreparedStatement } from '@floway-dev/platform';
import { assertThrows } from '@floway-dev/test-utils';

test('D1 compound SELECT verifier accepts five terms and rejects six', () => {
  assertD1CompoundSelectLimit('SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5');
  assertThrows(
    () => assertD1CompoundSelectLimit('SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6'),
    Error,
    'SQL query exceeds D1 compound SELECT limit of 5 terms',
  );
  assertD1CompoundSelectLimit("SELECT 'UNION UNION UNION UNION UNION' /* UNION */");
});

test('mapRunChangeCount maps run metadata changes', async () => {
  const db = await createSqliteTestDb();
  const mapper = vi.fn((changes: number) => changes * 3);
  const wrapped = mapRunChangeCount(db, mapper);

  const result = await wrapped
    .prepare('UPDATE users SET username = username WHERE id = 1')
    .run();

  expect(mapper).toHaveBeenCalledWith(1);
  expect(result.meta.changes).toBe(3);
});

test('mapRunChangeCount rejects missing run metadata changes', async () => {
  const statement: SqlPreparedStatement = {
    bind: () => statement,
    first: async () => null,
    all: async () => ({ results: [], success: true, meta: {} }),
    run: async () => ({ results: [], success: true, meta: {} }),
  };
  const db: SqlDatabase = {
    prepare: () => statement,
    exec: async () => undefined,
  };

  await expect(mapRunChangeCount(db, changes => changes).prepare('SELECT 1').run())
    .rejects.toThrow('SQL run result omitted its change count');
});
