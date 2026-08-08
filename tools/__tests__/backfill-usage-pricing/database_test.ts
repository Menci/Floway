import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { test } from 'vitest';

import { openD1Database, renderD1Statement } from '../../src/backfill-usage-pricing/d1-database.ts';
import { openNodeDatabase } from '../../src/backfill-usage-pricing/node-database.ts';
import { assertEquals, assertRejects, assertStringIncludes } from '@floway-dev/test-utils';

test('Node connector opens an existing database without creating missing paths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'floway-tools-node-'));
  const path = join(directory, 'usage.db');
  const seed = new DatabaseSync(path);
  seed.exec('CREATE TABLE example (value TEXT); INSERT INTO example VALUES (\'ok\')');
  seed.close();

  const database = await openNodeDatabase(path, 'read');
  try {
    assertEquals((await database.query<{ value: string }>({ sql: 'SELECT value FROM example' })).rows, [{ value: 'ok' }]);
  } finally {
    await database.close();
  }
  await assertRejects(() => openNodeDatabase(join(directory, 'missing.db'), 'write'));
});

test('D1 renderer binds values without interpreting placeholders inside SQL syntax', () => {
  const rendered = renderD1Statement({
    sql: "SELECT '?', \"?\", `?`, ? AS text, ? AS number, ? AS empty /* ? */ -- ?\n",
    params: ["Menci's 模型", 7, null],
  });
  assertStringIncludes(rendered, "SELECT '?', \"?\", `?`");
  assertStringIncludes(rendered, `CAST(X'${Buffer.from("Menci's 模型").toString('hex')}' AS TEXT)`);
  assertStringIncludes(rendered, '7 AS number');
  assertStringIncludes(rendered, 'NULL AS empty');
});

test('D1 connector resolves its binding and returns Wrangler JSON rows', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'floway-tools-d1-'));
  const configPath = join(directory, 'wrangler.jsonc');
  const persistTo = join(directory, 'state');
  const fs = await import('node:fs/promises');
  await fs.mkdir(persistTo);
  await writeFile(configPath, JSON.stringify({
    d1_databases: [{ binding: 'DB', database_id: 'database-id', database_name: 'floway-test' }],
  }));
  let invoked: readonly string[] = [];
  let invokedDatabaseId = '';
  const database = await openD1Database({
    binding: 'DB',
    configPath,
    location: 'local',
    persistTo,
    runner: async (_command, args) => {
      invoked = args;
      const snapshotPath = args[args.indexOf('--config') + 1]!;
      const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'));
      invokedDatabaseId = snapshot.d1_databases[0].database_id;
      return {
        exitCode: 0,
        stderr: '',
        stdout: JSON.stringify([{ success: true, results: [{ value: 'ok' }], meta: { changes: 0 } }]),
      };
    },
  });
  await writeFile(configPath, JSON.stringify({
    d1_databases: [{ binding: 'DB', database_id: 'different-id', database_name: 'different' }],
  }));
  assertEquals((await database.query<{ value: string }>({ sql: 'SELECT ? AS value', params: ['ok'] })).rows, [{ value: 'ok' }]);
  assertEquals(invokedDatabaseId, 'database-id');
  assertEquals(invoked.includes('--local'), true);
  assertEquals(invoked.includes('--persist-to'), true);
  assertEquals(invoked[invoked.indexOf('--config') + 1] === configPath, false);
  await database.close();
});

test('D1 connector serializes concurrent statements for local persistence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'floway-tools-d1-serial-'));
  const configPath = join(directory, 'wrangler.jsonc');
  const persistTo = join(directory, 'state');
  const fs = await import('node:fs/promises');
  await fs.mkdir(persistTo);
  await writeFile(configPath, JSON.stringify({
    d1_databases: [{ binding: 'DB', database_id: 'database-id', database_name: 'floway-test' }],
  }));
  let active = 0;
  let maxActive = 0;
  const database = await openD1Database({
    binding: 'DB',
    configPath,
    location: 'local',
    persistTo,
    runner: async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;
      return { exitCode: 0, stderr: '', stdout: JSON.stringify([{ success: true, results: [] }]) };
    },
  });
  await Promise.all([
    database.query({ sql: 'SELECT 1' }),
    database.query({ sql: 'SELECT 2' }),
  ]);
  assertEquals(maxActive, 1);
  await database.close();
});

test('D1 local identity tracks the effective preview database ID', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'floway-tools-d1-preview-'));
  const configPath = join(directory, 'wrangler.jsonc');
  const persistTo = join(directory, 'state');
  const fs = await import('node:fs/promises');
  await fs.mkdir(persistTo);
  const config = (previewDatabaseId: string) => JSON.stringify({
    d1_databases: [{
      binding: 'DB',
      database_id: 'production-id',
      database_name: 'floway-test',
      preview_database_id: previewDatabaseId,
    }],
  });
  await writeFile(configPath, config('preview-a'));
  const first = await openD1Database({
    binding: 'DB', configPath, location: 'local', persistTo, runner: async () => {
      throw new Error('not called');
    },
  });
  assertEquals(first.identity.kind === 'd1' ? first.identity.databaseId : null, 'preview-a');
  await first.close();

  await writeFile(configPath, config('preview-b'));
  const second = await openD1Database({
    binding: 'DB', configPath, location: 'local', persistTo, runner: async () => {
      throw new Error('not called');
    },
  });
  assertEquals(second.identity.kind === 'd1' ? second.identity.databaseId : null, 'preview-b');
  await second.close();
});
