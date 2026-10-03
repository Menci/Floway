import { test } from 'vitest';

import { createSqlJsDatabase, migrationSqlByFilename } from './test-sqlite.ts';
import { agentSetupConfigurationSchema } from '@floway-dev/agent-setup';
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

const AGENT_SETUP_TABLE_MIGRATION = '0060_agent_setup.sql';

// The configuration_json the schema wrote when 0060 created the table, and so
// the oldest shape a production row can still hold. Frozen deliberately: it
// records history, and updating it to today's shape would delete the very gap
// this test exists to measure.
const ORIGINAL_STORED_CONFIGURATION = {
  apiKeyId: 'key-1',
  claudeCode: {
    model: null,
    defaultOpusModel: null,
    defaultSonnetModel: null,
    defaultHaikuModel: null,
    effortLevel: null,
    modelDiscovery: true,
  },
  codex: { model: null, reasoningEffort: null },
};

const migrationSql = (filename: string): string => {
  const sql = migrationSqlByFilename.find(([candidate]) => candidate === filename)?.[1];
  if (sql === undefined) throw new Error(`Missing migration SQL fixture: ${filename}`);
  return sql;
};

// A configuration is parsed by the strict schema on the way out of the
// database, before any replacement row can be written, and the latest-record
// lookup ignores expiry — so a key added to the schema without a migration
// backfilling it does not degrade one request, it locks the owner out of Agent
// Setup permanently. Seeding the oldest row and running every migration over
// it makes the next such key fail here rather than in production.
test('the oldest stored Agent Setup configuration migrates into the current schema', async () => {
  const db = await createSqlJsDatabase();
  const filenames = migrationSqlByFilename.map(([filename]) => filename);
  const tableIndex = filenames.indexOf(AGENT_SETUP_TABLE_MIGRATION);
  assertEquals(tableIndex >= 0, true, `missing ${AGENT_SETUP_TABLE_MIGRATION}`);

  for (const filename of filenames.slice(0, tableIndex + 1)) db.run(migrationSql(filename));
  db.run(
    `INSERT INTO agent_setup (token, user_id, configuration_json, configuration_revision, expires_at, created_at, updated_at)
     VALUES ('token-1', 1, ?, 1, 4102444800000, 1700000000000, 1700000000000)`,
    [JSON.stringify(ORIGINAL_STORED_CONFIGURATION)],
  );
  for (const filename of filenames.slice(tableIndex + 1)) db.run(migrationSql(filename));

  const [stored] = db.exec(`SELECT configuration_json FROM agent_setup WHERE token = 'token-1'`);
  const migrated = agentSetupConfigurationSchema.safeParse(JSON.parse(String(stored!.values[0]![0])));
  assertEquals(
    migrated.success,
    true,
    migrated.success
      ? ''
      : `a migration is missing for: ${migrated.error.issues.map(issue => issue.path.join('.')).join(', ')}`,
  );
});
