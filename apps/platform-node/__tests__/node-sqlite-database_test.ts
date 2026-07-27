import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { test } from 'vitest';

import { createNodeSqliteDatabase } from '../src/node-sqlite-database.ts';
import { assert, assertEquals, assertRejects } from '@floway-dev/test-utils';

const withTempDb = async (fn: (dbPath: string) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), 'node-sqlite-db-'));
  try {
    await fn(join(dir, 'test.db'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

test('prepare/all returns rows in SqlResult envelope', () => withTempDb(async path => {
  const db = createNodeSqliteDatabase(path);
  await db.prepare('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)').run();
  await db.prepare('INSERT INTO t (id, name) VALUES (?, ?)').bind(1, 'a').run();
  await db.prepare('INSERT INTO t (id, name) VALUES (?, ?)').bind(2, 'b').run();

  const result = await db.prepare('SELECT id, name FROM t ORDER BY id').all<{ id: number; name: string }>();
  assertEquals(result.success, true);
  assertEquals(result.results, [{ id: 1, name: 'a' }, { id: 2, name: 'b' }]);
}));

test('first returns first row or null', () => withTempDb(async path => {
  const db = createNodeSqliteDatabase(path);
  await db.prepare('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)').run();
  await db.prepare('INSERT INTO t (id, name) VALUES (?, ?)').bind(7, 'seven').run();

  const hit = await db.prepare('SELECT id, name FROM t WHERE id = ?').bind(7).first<{ id: number; name: string }>();
  assertEquals(hit, { id: 7, name: 'seven' });

  const miss = await db.prepare('SELECT id, name FROM t WHERE id = ?').bind(99).first();
  assertEquals(miss, null);
}));

test('run reports changes for INSERT / UPDATE / DELETE', () => withTempDb(async path => {
  const db = createNodeSqliteDatabase(path);
  await db.prepare('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)').run();

  const ins = await db.prepare('INSERT INTO t (id, name) VALUES (?, ?), (?, ?)').bind(1, 'a', 2, 'b').run();
  assertEquals(ins.meta.changes, 2);

  const upd = await db.prepare('UPDATE t SET name = ? WHERE id = ?').bind('A', 1).run();
  assertEquals(upd.meta.changes, 1);

  const del = await db.prepare('DELETE FROM t WHERE id = ?').bind(1).run();
  assertEquals(del.meta.changes, 1);
}));

test('batch executes statements in order and returns each result', () => withTempDb(async path => {
  const db = createNodeSqliteDatabase(path);
  assert(db.batch !== undefined, 'batch must be implemented');
  await db.prepare('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)').run();

  const results = await db.batch([
    db.prepare('INSERT INTO t (id, name) VALUES (?, ?)').bind(1, 'a'),
    db.prepare('INSERT INTO t (id, name) VALUES (?, ?)').bind(2, 'b'),
    db.prepare('UPDATE t SET name = ? WHERE id = ?').bind('A', 1),
  ]);
  assertEquals(results.length, 3);
  assertEquals(results.map(r => r.meta.changes), [1, 1, 1]);

  const rows = await db.prepare('SELECT id, name FROM t ORDER BY id').all<{ id: number; name: string }>();
  assertEquals(rows.results, [{ id: 1, name: 'A' }, { id: 2, name: 'b' }]);
}));

test('batch rolls back on mid-batch failure', () => withTempDb(async path => {
  const db = createNodeSqliteDatabase(path);
  await db.prepare('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)').run();
  await db.prepare('INSERT INTO t (id, name) VALUES (?, ?)').bind(1, 'a').run();

  await assertRejects(
    () => db.batch!([
      db.prepare('INSERT INTO t (id, name) VALUES (?, ?)').bind(2, 'b'),
      // Duplicate primary key — fails after the first succeeds.
      db.prepare('INSERT INTO t (id, name) VALUES (?, ?)').bind(1, 'dup'),
    ]),
  );

  const rows = await db.prepare('SELECT id FROM t ORDER BY id').all<{ id: number }>();
  // Only the pre-batch insert should remain — the in-batch INSERT(id=2) was rolled back.
  assertEquals(rows.results, [{ id: 1 }]);
}));

test('concurrent batch calls do not interleave transactions', () => withTempDb(async path => {
  // Regression: an `await` between BEGIN and COMMIT used to yield a microtask,
  // letting a second batch call's BEGIN run while the first transaction was
  // still open and trip "cannot start a transaction within a transaction".
  const db = createNodeSqliteDatabase(path);
  await db.prepare('CREATE TABLE t (id INTEGER PRIMARY KEY)').run();

  await Promise.all([
    db.batch!([db.prepare('INSERT INTO t (id) VALUES (?)').bind(1)]),
    db.batch!([db.prepare('INSERT INTO t (id) VALUES (?)').bind(2)]),
  ]);

  const rows = await db.prepare('SELECT id FROM t ORDER BY id').all<{ id: number }>();
  assertEquals(rows.results, [{ id: 1 }, { id: 2 }]);
}));

test('foreign key enforcement is on', () => withTempDb(async path => {
  const db = createNodeSqliteDatabase(path);
  await db.prepare('CREATE TABLE parent (id INTEGER PRIMARY KEY)').run();
  await db.prepare('CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id))').run();

  await assertRejects(
    () => db.prepare('INSERT INTO child (id, parent_id) VALUES (?, ?)').bind(1, 999).run(),
  );
}));
