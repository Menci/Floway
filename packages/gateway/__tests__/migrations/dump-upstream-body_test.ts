import { DatabaseSync } from 'node:sqlite';

import { expect, test } from 'vitest';

import { migrationSqlByFilename } from '../repo/test-sqlite.ts';

const MIGRATION = '0089_dump_upstream_body.sql';

// The upstream body column is additive: nullable, and the three spilled-files
// triggers from 0066 are rebuilt to cover the new descriptor. The rebuilt
// triggers' behavior is exercised end-to-end by the dump-store round-trip
// tests (an upstream file is staged, adopted to `owned`, and rehydrated); this
// test asserts the migration itself: the column appears, it is nullable, and
// the rebuilt triggers are present by name.
test('0089 adds a nullable response_upstream_body_descriptor column', () => {
  const before = new DatabaseSync(':memory:');
  for (const [filename, sql] of migrationSqlByFilename) {
    if (filename === MIGRATION) break;
    before.exec(sql);
  }
  const columnsBefore = before.prepare('PRAGMA table_info(dump_records)').all() as { name: string }[];
  expect(columnsBefore.some(col => col.name === 'response_upstream_body_descriptor')).toBe(false);
  expect(before.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='dump_records_adopt_spilled_files'").get()).toBeDefined();
  before.close();

  const after = new DatabaseSync(':memory:');
  for (const [, sql] of migrationSqlByFilename) after.exec(sql);
  const columnsAfter = after.prepare('PRAGMA table_info(dump_records)').all() as { name: string; notnull: number }[];
  const col = columnsAfter.find(c => c.name === 'response_upstream_body_descriptor');
  expect(col).toBeDefined();
  expect(col!.notnull).toBe(0); // nullable
  // The rebuilt triggers are present (rebuilt, not dropped) after 0089.
  for (const trigger of [
    'dump_records_validate_spilled_files',
    'dump_records_adopt_spilled_files',
    'dump_records_retire_spilled_files',
  ]) {
    expect(after.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name=?").get(trigger)).toBeDefined();
  }
  after.close();
});
