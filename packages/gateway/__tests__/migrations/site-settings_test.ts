import { expect, test } from 'vitest';

import { createSqlJsDatabase, migrationSqlByFilename } from '../repo/test-sqlite.ts';

test('the site settings migration seeds one row with no name override', async () => {
  const db = await createSqlJsDatabase();
  for (const [, sql] of migrationSqlByFilename) db.run(sql);

  const rows = db.exec('SELECT id, site_name FROM site_settings')[0]!.values;

  expect(rows).toEqual([[1, null]]);
  db.close();
});

test('the site settings table rejects a blank name and a second row', async () => {
  const db = await createSqlJsDatabase();
  for (const [, sql] of migrationSqlByFilename) db.run(sql);

  expect(() => db.run("UPDATE site_settings SET site_name = '' WHERE id = 1")).toThrow();
  expect(() => db.run("INSERT INTO site_settings (id, site_name, updated_at) VALUES (2, 'Other', '')")).toThrow();
  db.close();
});
