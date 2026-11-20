import { test } from 'vitest';

import { InMemoryRepo } from './memory.ts';
import { type CompletedStatement, recordCompletedStatements } from './recording-sql.ts';
import { assertD1CompoundSelectLimit, createSqliteTestDb } from './test-sqlite.ts';
import { SqlRepo } from '../../src/repo/sql.ts';
import type { ApiKey, Repo, UsageOverviewQueryOptions, UsageRecord } from '../../src/repo/types.ts';
import { tokenRatesFromUsage, tokenUsageMetrics } from '../../src/repo/usage-metrics.ts';
import type { PriceVector } from '@floway-dev/protocols/common';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

// The usage repo threads the (service tier × input length) grid coordinate
// through persistence. These cases run against both backends — the SQL repo
// applies every migration (including canonical pricing selector storage) against a real sql.js database, and the in-memory repo mirrors the
// same bucket identity — so the two stay behaviorally identical.
const backends: { name: string; make: () => Promise<Repo> }[] = [
  { name: 'sql', make: async () => new SqlRepo(await createSqliteTestDb()) },
  { name: 'memory', make: () => Promise.resolve(new InMemoryRepo()) },
];

const longPricing: PriceVector = { input_tokens: '0.00001', input_cache_read_tokens: '0.000001', output_tokens: '0.000045' };

const record = (overrides: Partial<UsageRecord>): UsageRecord => ({
  keyId: 'key-1',
  model: 'gpt-5.6-sol',
  upstream: 'up_chatgpt',
  modelKey: 'gpt-5.6-sol',
  hour: '2026-07-12T00',
  pricingSelector: {},
  requests: 1,
  metrics: tokenUsageMetrics({ input: 300_000, input_cache_read: 20_000, output: 100_000 }, longPricing),
  ...overrides,
});

const apiKey = (id: string, userId: number): ApiKey => ({
  id,
  userId,
  name: id,
  key: `raw-${id}`,
  serverSecret: String(userId).padStart(2, '0').repeat(32),
  createdAt: '2026-01-01T00:00:00.000Z',
  upstreamIds: null,
  randomizeUpstreams: false,
  deletedAt: null,
  dumpRetentionSeconds: null,
  openaiResponsesRetentionSeconds: 0,
});

const query = (repo: Repo) => repo.usage.query({ keyIds: ['key-1'], start: '2026-07-12T00', end: '2026-07-12T01' });

for (const backend of backends) {
  test(`${backend.name} usage repo scopes a time window to a set of keys`, async () => {
    const repo = await backend.make();
    await Promise.all([
      repo.usage.record(record({ keyId: 'key-1', requests: 1 })),
      repo.usage.record(record({ keyId: 'key-2', requests: 2 })),
      repo.usage.record(record({ keyId: 'key-3', requests: 3 })),
      repo.usage.record(record({ keyId: 'key-2', hour: '2026-07-12T01', requests: 4 })),
    ]);

    const scoped = await repo.usage.query({ keyIds: ['key-2', 'key-2', 'key-3'], start: '2026-07-12T00', end: '2026-07-12T01' });
    assertEquals(scoped.map(row => [row.keyId, row.requests]), [['key-2', 2], ['key-3', 3]]);
    assertEquals(await repo.usage.query({ keyIds: [], start: '2026-07-12T00', end: '2026-07-12T01' }), []);
    assertEquals((await repo.usage.query({ start: '2026-07-12T00', end: '2026-07-12T01' })).length, 3);
  });

  test(`${backend.name} usage repo folds the selected input-length pricing entry into per-metric unit prices at write time`, async () => {
    const repo = await backend.make();
    await repo.usage.record(record({ pricingSelector: { inputTokens: { operator: 'gt', value: 272000 } } }));
    const [row] = await query(repo);
    assertEquals(row.pricingSelector, { inputTokens: { operator: 'gt', value: 272000 } });
    // The whole bucket is priced at the long-band rates, not the base rates.
    // Only metrics that carry tokens get a unit-price snapshot.
    assertEquals(tokenRatesFromUsage(row), longPricing);
  });

  test(`${backend.name} usage repo retains the request when metric persistence fails`, async () => {
    const repo = await backend.make();
    await assertRejects(() => repo.usage.record(record({
      metrics: [{ metric: 'input_tokens', quantity: '01.0', unitPrice: null }],
    })), TypeError);
    const [stored] = await query(repo);
    assertEquals(stored.requests, 1);
    assertEquals(stored.metrics, []);
  });
}

test('SQL usage hydration rejects vocabulary unknown to the current application', async () => {
  const db = await createSqliteTestDb();
  await db.prepare(`INSERT INTO usage (
    key_id, model, upstream, model_key, hour, pricing_selector,
    metric, quantity, unit_price
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    'key-1', 'model', null, 'model', '2026-07-12T00', '{}',
    'reasoning', '1', null,
  ).run();
  await assertRejects(() => new SqlRepo(db).usage.listAll(), TypeError);
});

test('SQL usage repo atomically rolls concurrent decimal writes into one metric row', async () => {
  const db = await createSqliteTestDb();
  const repo = new SqlRepo(db);
  await Promise.all(Array.from({ length: 50 }, () => repo.usage.record(record({
    metrics: [{ metric: 'input_tokens', quantity: '0.1', unitPrice: '0.000002' }],
  }))));

  const [stored] = await query(repo);
  assertEquals(stored.metrics, [{ metric: 'input_tokens', quantity: '5', unitPrice: '0.000002' }]);
  assertEquals(stored.requests, 50);
  assertEquals(await db.prepare('SELECT COUNT(*) AS count FROM usage').first(), { count: 1 });
});

test('SQL usage overview matches the in-memory oracle across filters, facets, axes, and exact decimals', async () => {
  const sql = new SqlRepo(await createSqliteTestDb());
  const memory = new InMemoryRepo();
  const repos = [sql, memory];
  for (const repo of repos) {
    await repo.apiKeys.save(apiKey('key-1', 1));
    await repo.apiKeys.save(apiKey('key-2', 2));
    await Promise.all([
      repo.usage.set(record({
        keyId: 'key-1', model: 'model-a', modelKey: 'storage-a', upstream: null,
        hour: '2026-11-01T05', requests: 1,
        metrics: [{ metric: 'input_tokens', quantity: '9007199254740992', unitPrice: '0.0000001' }],
      })),
      repo.usage.set(record({
        keyId: 'key-1', model: 'model-a', modelKey: 'storage-b', upstream: null,
        hour: '2026-11-01T06', requests: 2,
        pricingSelector: { serviceTier: 'priority' },
        metrics: [{ metric: 'input_tokens', quantity: '0.1', unitPrice: '0.2' }],
      })),
      repo.usage.set(record({
        keyId: 'key-2', model: 'model-b', upstream: 'none',
        hour: '2026-11-01T06', requests: 4,
        metrics: [{ metric: 'output_tokens', quantity: '3', unitPrice: null }],
      })),
      repo.usage.set(record({
        keyId: 'ghost', model: 'model-b', upstream: null,
        hour: '2026-11-01T07', requests: 8,
        metrics: [{ metric: 'input_tokens', quantity: '0', unitPrice: '0.3' }],
      })),
    ]);
  }
  const options: UsageOverviewQueryOptions = {
    actorUserId: 1,
    isAdmin: true,
    visibleUserIds: [],
    visibleUpstreams: [],
    start: '2026-11-01T05',
    end: '2026-11-01T08',
    ownedKeysOnly: false,
    filters: { keyIds: [], userIds: [], models: ['model-a', 'model-b'], upstreams: ['none'] },
    bucketForHour: hour => hour === '2026-11-01T05' || hour === '2026-11-01T06'
      ? '2026-11-01T01'
      : '2026-11-01T02',
  };

  for (const bucketForHour of [options.bucketForHour, (hour: string) => hour, () => 'all-hours']) {
    for (const actor of [
      { actorUserId: 1, isAdmin: true, visibleUserIds: [], visibleUpstreams: [] },
      { actorUserId: 2, isAdmin: false, visibleUserIds: [2], visibleUpstreams: [] },
      { actorUserId: 2, isAdmin: false, visibleUserIds: [1, 2], visibleUpstreams: [] },
      { actorUserId: 2, isAdmin: false, visibleUserIds: [], visibleUpstreams: ['none'] },
    ]) {
      for (const ownedKeysOnly of [false, true]) {
        for (const filters of [
          { keyIds: [], userIds: [], models: [], upstreams: [] },
          { keyIds: [], userIds: [0], models: [], upstreams: [] },
          { keyIds: ['key-1'], userIds: [1], models: ['model-a'], upstreams: ['none'] },
          { keyIds: [], userIds: [], models: ['missing'], upstreams: [] },
        ]) {
          const queryOptions = { ...options, ...actor, ownedKeysOnly, bucketForHour, filters };
          assertEquals(
            await sql.usage.queryOverview(queryOptions),
            await memory.usage.queryOverview(queryOptions),
          );
        }
      }
    }
  }

  const allHours = { ...options, bucketForHour: () => 'all-hours' };
  const [expected] = await memory.usage.queryOverview(allHours);
  const [actual] = await sql.usage.queryOverview(allHours);

  assertEquals(actual, expected);
  assertEquals(actual!.dimensionValues, {
    keyIds: ['key-1'],
    userIds: [0, 1, 2],
    models: ['model-a', 'model-b'],
    upstreams: ['none', 'upstream:none'],
  });
  assertEquals(actual!.axes.none[0], {
    group: 'all',
    requests: 11,
    metrics: [{ metric: 'input_tokens', quantity: '9007199254740992.1' }],
    cost: '900719925.4940992',
  });
});

test('SQL usage overview stays within the D1 compound-select limit and returns grouped term cardinality', async () => {
  const db = await createSqliteTestDb();
  const seedRepo = new SqlRepo(db);
  await seedRepo.apiKeys.save(apiKey('key-1', 1));
  await Promise.all(Array.from({ length: 80 }, (_, index) => seedRepo.usage.set(record({
    model: 'shared-model',
    modelKey: `storage-${index}`,
    pricingSelector: { serviceTier: `tier-${index}` },
    metrics: [{ metric: 'input_tokens', quantity: String(index + 1) as `${number}`, unitPrice: '0.5' }],
  }))));
  const completed: CompletedStatement[] = [];
  const repo = new SqlRepo(recordCompletedStatements(db, completed));

  const [overview] = await repo.usage.queryOverview({
    actorUserId: 1,
    isAdmin: true,
    visibleUserIds: [],
    visibleUpstreams: [],
    start: '2026-07-12T00',
    end: '2026-07-12T01',
    ownedKeysOnly: false,
    filters: { keyIds: [], userIds: [], models: [], upstreams: [] },
    bucketForHour: hour => hour,
  });

  const rawRows = await db.prepare('SELECT (SELECT COUNT(*) FROM usage) + (SELECT COUNT(*) FROM usage_requests) AS count')
    .first<{ count: number }>();
  const aggregates = completed.filter(statement => statement.query.startsWith('/* usage-overview */'));
  const aggregate = aggregates.at(-1);
  if (!aggregate || !rawRows) throw new Error('Usage overview SQL evidence was not captured');
  assertD1CompoundSelectLimit(aggregate.query);
  assertEquals(rawRows.count, 160);
  assertEquals(aggregates.length, 1);
  assertEquals(aggregate.resultCount < rawRows.count, true);
  assertEquals(overview!.axes.none[0], {
    group: 'all', requests: 80,
    metrics: [{ metric: 'input_tokens', quantity: '3240' }], cost: '1620',
  });
});
