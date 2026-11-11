import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, expect, test } from 'vitest';
import { getPlatformProxy, type PlatformProxy, unstable_splitSqlQuery as splitSqlQuery } from 'wrangler';

import { SqlRepo } from '@floway-dev/gateway';
import { migrationsDir } from '@floway-dev/gateway/migrations-dir';
import type { SqlDatabase } from '@floway-dev/platform';

let directory: string;
let platform: PlatformProxy<{ DB: SqlDatabase }> | undefined;
let repo: SqlRepo;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'floway-statistics-d1-'));
  const configPath = join(directory, 'wrangler.jsonc');
  await writeFile(configPath, JSON.stringify({
    name: 'floway-statistics-test',
    compatibility_date: '2025-01-01',
    d1_databases: [{ binding: 'DB', database_name: 'statistics', database_id: 'statistics' }],
  }));
  platform = await getPlatformProxy<{ DB: SqlDatabase }>({ configPath, persist: false, remoteBindings: false });
  const db = platform.env.DB;
  const referenceQuery = (count: number) => `WITH q AS (SELECT 1 AS x)
    SELECT COUNT(*) AS value FROM (SELECT 1)
    WHERE 1 IN (${Array<string>(count).fill('(SELECT x FROM q)').join(', ')})`;
  expect(await db.prepare(referenceQuery(90)).first()).toEqual({ value: 1 });
  await expect(db.prepare(referenceQuery(110)).first()).rejects.toThrow('VIEWs and/or subqueries nested too deep');

  if (!db.batch) throw new Error('Floway D1 regression database has no batch API');
  for (const filename of (await readdir(migrationsDir)).filter(name => name.endsWith('.sql')).sort()) {
    const statements = splitSqlQuery(await readFile(new URL(filename, migrationsDir), 'utf8'));
    await db.batch(statements.map(sql => db.prepare(sql)));
  }
  repo = new SqlRepo(db);
  await repo.apiKeys.save({
    id: 'statistics-key', userId: 1, name: 'Statistics', key: 'statistics-secret',
    serverSecret: '01'.repeat(32), createdAt: '2026-11-01T00:00:00.000Z',
    upstreamIds: null, randomizeUpstreams: false, deletedAt: null,
    dumpRetentionSeconds: null, openaiResponsesRetentionSeconds: 0,
  });
  await repo.usage.set({
    keyId: 'statistics-key', model: 'statistics-model', upstream: null,
    modelKey: 'storage-model', hour: '2026-11-01T00', pricingSelector: {}, requests: 3,
    metrics: [{ metric: 'input_tokens', quantity: '9007199254740992.5', unitPrice: '0.2' }],
  });
  await repo.performance.set({
    keyId: 'statistics-key', model: 'statistics-model', upstream: 'statistics-upstream',
    operation: 'chat', runtimeLocation: 'HKG', hour: '2026-11-01T00', requests: 3,
    ttftSamplesOk: 2, errorsWithOutput: 0, errorsNoOutput: 1, neutral: 0,
    tpotSamples: 2, ttftMsSum: 100, tpotUsSum: 500,
    buckets: [
      { metric: 'ttft_ms', lower: 0, upper: 100, count: 2 },
      { metric: 'tpot_us', lower: 0, upper: 500, count: 2 },
    ],
  });
}, 30_000);

afterAll(async () => {
  await platform?.dispose();
  if (directory) await rm(directory, { recursive: true, force: true });
});

test.each([
  { groupBy: 'model', isAdmin: true },
  { groupBy: 'keyId', isAdmin: true },
  { groupBy: 'model', isAdmin: false },
  { groupBy: 'keyId', isAdmin: false },
] as const)('D1 statistics compile and retain exact results for $groupBy (admin: $isAdmin)', async ({ groupBy, isAdmin }) => {
  const options = {
    actorUserId: 1, isAdmin, groupBy, visibleUserIds: [1], visibleUpstreams: ['statistics-upstream'],
    start: '2026-11-01T00', end: '2026-11-01T01', bucketForHour: (hour: string) => hour,
  };
  const filters = { models: [], upstreams: [], userIds: [], keyIds: [] };
  const usage = await repo.usage.queryOverview({ ...options, filters });
  expect(usage.axes.none[0]).toEqual({
    bucket: 'all', group: 'all', requests: 3,
    metrics: [{ metric: 'input_tokens', quantity: '9007199254740992.5' }], cost: '1801439850948198.5',
  });
  expect(usage.dimensionValues.keyIds).toEqual(['statistics-key']);
  expect(await repo.usage.queryOverview({
    ...options,
    filters: { models: ['statistics-model'], upstreams: usage.dimensionValues.upstreams, userIds: [1], keyIds: ['statistics-key'] },
  })).toEqual(usage);

  const performance = await repo.performance.queryOverview({ ...options, filters: { ...filters, operations: [], runtimeLocations: [] } });
  expect(performance.axes.none[0]).toMatchObject({
    bucket: 'all', group: 'all', requests: 3, errors: 1, ttftSamples: 2, tpotSamples: 2,
    ttftMsP50: 100 / 3, ttftMsP95: 200 / 3, tpotUsP50: 500 / 3, tpotUsP95: 1000 / 3,
  });
  expect(performance.dimensionValues.keyIds).toEqual(['statistics-key']);
  expect(await repo.performance.queryOverview({
    ...options,
    filters: {
      models: ['statistics-model'], upstreams: ['statistics-upstream'], userIds: [1], keyIds: ['statistics-key'],
      operations: ['chat'], runtimeLocations: ['HKG'],
    },
  })).toEqual(performance);
});
