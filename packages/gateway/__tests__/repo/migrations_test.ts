import { test } from 'vitest';

import { createSqliteTestDb, migrationSqlByFilename } from './test-sqlite.ts';
import { assertEquals } from '@floway-dev/test-utils';

// Migration filenames must start with a unique NNNN_ prefix so lexical order
// agrees with `wrangler d1 migrations apply`. These collisions predate the
// guard and are already applied in production, so renaming them would create
// new migration identities rather than repairing the old ones.
const KNOWN_DUPLICATE_PREFIXES: ReadonlySet<string> = new Set(['0011', '0025']);

test('every migration file has a unique numeric prefix', () => {
  const byPrefix = new Map<string, string[]>();
  for (const [filename] of migrationSqlByFilename) {
    const match = /^(\d{4})_/.exec(filename);
    assertEquals(match !== null, true, `migration filename must start with NNNN_: ${filename}`);
    const prefix = match![1];
    const bucket = byPrefix.get(prefix) ?? [];
    bucket.push(filename);
    byPrefix.set(prefix, bucket);
  }
  const collisions = [...byPrefix.entries()]
    .filter(([prefix, bucket]) => bucket.length > 1 && !KNOWN_DUPLICATE_PREFIXES.has(prefix))
    .map(([, bucket]) => bucket);
  assertEquals(collisions, [], `duplicate migration numbers: ${JSON.stringify(collisions)}`);
});

test('current-schema test databases are isolated clones of one migrated template', async () => {
  const first = await createSqliteTestDb();
  const second = await createSqliteTestDb();
  await first.exec('CREATE TABLE clone_only (id INTEGER PRIMARY KEY)');

  assertEquals(
    await second.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'clone_only'").first(),
    null,
  );
});
