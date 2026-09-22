import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { test } from 'vitest';

import { assertEquals } from '@floway-dev/test-utils';

const CLI = fileURLToPath(new URL('../../src/backfill-usage-pricing/cli.ts', import.meta.url));
const TSX_LOADER = fileURLToPath(import.meta.resolve('tsx'));

// Three `tsx` subprocesses, each paying its own loader startup. The default 5 s is marginal
// for that on a loaded machine — the test passes alone and inside a quiet suite and times out
// under a full `verify`, which is a stopwatch failing rather than the CLI.
test('non-interactive CLI writes a private plan and applies only that artifact', { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'floway-tools-cli-'));
  const databasePath = join(directory, 'floway.db');
  const planPath = join(directory, 'plan.json');
  const db = new DatabaseSync(databasePath);
  db.exec(`
    CREATE TABLE upstreams (
      id TEXT PRIMARY KEY, provider TEXT NOT NULL, name TEXT NOT NULL, enabled INTEGER NOT NULL,
      sort_order INTEGER NOT NULL, created_at TEXT NOT NULL, config_json TEXT NOT NULL,
      models_cache_json TEXT
    );
    CREATE TABLE usage (
      key_id TEXT NOT NULL, model TEXT NOT NULL, upstream TEXT, model_key TEXT NOT NULL,
      hour TEXT NOT NULL, pricing_selector TEXT NOT NULL, metric TEXT NOT NULL,
      quantity TEXT NOT NULL, unit_price TEXT
    );
    CREATE UNIQUE INDEX idx_usage_metric_identity
      ON usage (key_id, model, COALESCE(upstream, ''), model_key, hour, pricing_selector, metric);
  `);
  const config = {
    models: [{
      kind: 'chat',
      endpoints: { openaiResponses: {} },
      upstreamModelId: 'wire',
      pricing: { entries: [{ rates: { input_tokens: '0.01' } }] },
    }],
  };
  db.prepare('INSERT INTO upstreams VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('azure-1', 'azure', 'Azure', 1, 0, '2026-01-01T00:00:00.000Z', JSON.stringify(config), null);
  db.prepare('INSERT INTO usage VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('key-1', 'public', 'azure-1', 'wire', '2026-01-01T00', '{}', 'input_tokens', '10', null);
  db.close();

  const planned = spawnSync(process.execPath, [
    '--import', TSX_LOADER, CLI, 'plan',
    '--database', 'node', '--database-path', 'floway.db',
    '--upstream', 'azure-1', '--model', 'public', '--model-key', 'wire',
    '--start-hour', '2026-01-01T00', '--end-hour', '2026-01-02T00',
    '--timezone', 'UTC', '--mode', 'fill', '--metric', 'input_tokens',
    '--output', 'plan.json',
  ], { encoding: 'utf8', env: { ...process.env, INIT_CWD: directory } });
  assertEquals(planned.status, 0, planned.stderr);
  assertEquals(JSON.parse(planned.stdout).kind, 'usage-pricing-plan-created');
  assertEquals(JSON.parse(await readFile(planPath, 'utf8')).kind, 'usage-pricing-backfill-plan');
  if (process.platform !== 'win32') assertEquals((await stat(planPath)).mode & 0o777, 0o600);

  const applied = spawnSync(process.execPath, ['--import', TSX_LOADER, CLI, 'apply', '--plan', 'plan.json'], {
    encoding: 'utf8',
    env: { ...process.env, INIT_CWD: directory },
  });
  assertEquals(applied.status, 0, applied.stderr);
  const appliedResult = JSON.parse(applied.stdout);
  assertEquals(appliedResult.rowsUpdated, 1);
  assertEquals(appliedResult.summary, { remainingNullRows: 0, remainingNullRowsByMetric: {} });
});
