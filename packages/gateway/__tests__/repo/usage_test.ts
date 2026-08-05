import { test } from 'vitest';

import { InMemoryRepo } from './memory.ts';
import { createSqliteTestDb, createSqlJsDatabase, migrationSqlByFilename } from './test-sqlite.ts';
import { SqlRepo } from '../../src/repo/sql.ts';
import type { ApiKey, Repo, UsageOverviewQueryOptions, UsageRecord } from '../../src/repo/types.ts';
import { tokenCountsFromUsage, tokenRatesFromUsage, tokenUsageMetrics } from '../../src/repo/usage-metrics.ts';
import type { SqlBindValue, SqlDatabase } from '@floway-dev/platform';
import type { PriceVector } from '@floway-dev/protocols/common';
import { assertEquals, assertRejects, assertThrows } from '@floway-dev/test-utils';

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
  upstream: 'up_codex',
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
  deletedAt: null,
  dumpRetentionSeconds: null,
  responsesRetentionSeconds: 0,
});

const query = (repo: Repo) => repo.usage.query({ keyIds: ['key-1'], start: '2026-07-12T00', end: '2026-07-12T01' });

interface CapturedStatement {
  query: string;
  binds: readonly SqlBindValue[];
}

const recordBoundStatements = (db: SqlDatabase, captured: CapturedStatement[]): SqlDatabase => ({
  prepare: queryText => {
    const statement = db.prepare(queryText);
    return {
      bind: (...binds) => {
        captured.push({ query: queryText, binds });
        return statement.bind(...binds);
      },
      first: () => statement.first(),
      all: () => statement.all(),
      run: () => statement.run(),
    };
  },
  exec: sql => db.exec(sql),
});

test('0052 preserves distinct open-string service tiers as canonical selectors', async () => {
  const db = await createSqlJsDatabase();
  for (const [filename, sql] of migrationSqlByFilename) {
    if (filename === '0053_usage_pricing_selector.sql') {
      db.run(`INSERT INTO usage (key_id, model, upstream, model_key, hour, tier, dimension, tokens, unit_price) VALUES
        ('k', 'm', NULL, 'mk', '2026-01-01T00', NULL, 'input', 10, 1),
        ('k', 'm', NULL, 'mk', '2026-01-01T00', '  ', 'input', 20, 2),
        ('k', 'm', NULL, 'mk', '2026-01-01T00', 'pri"雪', 'input', 30, 3),
        ('k', 'm', NULL, 'mk', '2026-01-01T00', 'tiny', 'input', 40, 1e-20),
        ('k', 'm', NULL, 'mk', '2026-01-01T00', 'precise', 'input', 50, 0.12345678901234566)`);
      db.run(`INSERT INTO usage_requests (key_id, model, upstream, model_key, hour, tier, requests) VALUES
        ('k', 'm', NULL, 'mk', '2026-01-01T00', NULL, 1),
        ('k', 'm', NULL, 'mk', '2026-01-01T00', '  ', 2),
        ('k', 'm', NULL, 'mk', '2026-01-01T00', 'pri"雪', 3),
        ('k', 'm', NULL, 'mk', '2026-01-01T00', 'tiny', 4),
        ('k', 'm', NULL, 'mk', '2026-01-01T00', 'precise', 5)`);
    }
    db.run(sql);
  }
  const usageRows = db.exec('SELECT pricing_selector, metric, quantity, unit_price FROM usage ORDER BY CAST(quantity AS REAL)')[0]!.values;
  const requestRows = db.exec('SELECT pricing_selector, requests FROM usage_requests ORDER BY requests')[0]!.values;
  assertEquals(usageRows, [
    ['{}', 'input_tokens', '10', '0.000001'],
    ['{"serviceTier":"  "}', 'input_tokens', '20', '0.000002'],
    ['{"serviceTier":"pri\\"雪"}', 'input_tokens', '30', '0.000003'],
    ['{"serviceTier":"tiny"}', 'input_tokens', '40', '0.00000000000000000000000001'],
    ['{"serviceTier":"precise"}', 'input_tokens', '50', '0.00000012345678901234566'],
  ]);
  assertEquals(requestRows, [
    ['{}', 1],
    ['{"serviceTier":"  "}', 2],
    ['{"serviceTier":"pri\\"雪"}', 3],
    ['{"serviceTier":"tiny"}', 4],
    ['{"serviceTier":"precise"}', 5],
  ]);
});

test('0062 rejects malformed legacy usage quantities and prices', async () => {
  for (const [tokens, unitPrice] of [
    ['1', "'not-a-price'"],
    ['1', '1e999'],
    ['-1', '1'],
    ['1.5', '1'],
    ["'not-a-quantity'", '1'],
  ]) {
    const db = await createSqlJsDatabase();
    for (const [filename, sql] of migrationSqlByFilename) {
      if (filename === '0062_usage_billing_metrics.sql') {
        db.run(`INSERT INTO usage (
          key_id, model, upstream, model_key, hour, pricing_selector, dimension, tokens, unit_price
        ) VALUES ('k', 'm', NULL, 'mk', '2026-01-01T00', '{}', 'input', ${tokens}, ${unitPrice})`);
        assertThrows(() => db.run(sql), Error, 'malformed JSON');
        break;
      }
      db.run(sql);
    }
  }
});

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

  test(`${backend.name} usage repo keeps different input-length bands in separate buckets`, async () => {
    const repo = await backend.make();
    const basePricing: PriceVector = { input_tokens: '0.000005', input_cache_read_tokens: '0.0000005', output_tokens: '0.00003' };
    await repo.usage.record(record({ metrics: tokenUsageMetrics({ input: 100, input_cache_read: 20, output: 50 }, basePricing), pricingSelector: {} }));
    await repo.usage.record(record({ pricingSelector: { inputTokens: { operator: 'gt', value: 272000 } }, metrics: tokenUsageMetrics({ input: 300_000, input_cache_read: 20_000, output: 100_000 }, longPricing) }));
    const rows = (await query(repo)).sort((a, b) => Object.keys(a.pricingSelector).length - Object.keys(b.pricingSelector).length);
    assertEquals(rows.length, 2);
    assertEquals(rows[0].pricingSelector, {});
    assertEquals(tokenRatesFromUsage(rows[0]), basePricing);
    assertEquals(rows[1].pricingSelector, { inputTokens: { operator: 'gt', value: 272000 } });
    assertEquals(tokenRatesFromUsage(rows[1]), longPricing);
  });

  test(`${backend.name} usage repo sums additive writes within one pricing entry`, async () => {
    const repo = await backend.make();
    await repo.usage.record(record({ pricingSelector: { inputTokens: { operator: 'gt', value: 272000 } } }));
    await repo.usage.record(record({ pricingSelector: { inputTokens: { operator: 'gt', value: 272000 } } }));
    const rows = await query(repo);
    assertEquals(rows.length, 1);
    assertEquals(tokenCountsFromUsage(rows[0]), { input: 600_000, input_cache_read: 40_000, output: 200_000 });
    assertEquals(rows[0].requests, 2);
  });

  test(`${backend.name} usage repo stores requests from models without pricing as unpriced`, async () => {
    const repo = await backend.make();
    await repo.usage.record(record({ metrics: tokenUsageMetrics({ input: 300_000, input_cache_read: 20_000, output: 100_000 }, null), pricingSelector: {} }));
    const [row] = await query(repo);
    assertEquals(tokenRatesFromUsage(row), null);
  });

  test(`${backend.name} usage repo keeps an unpriced first-write snapshot when later writes are priced`, async () => {
    const repo = await backend.make();
    await repo.usage.record(record({ metrics: tokenUsageMetrics({ input: 100 }, null) }));
    await repo.usage.record(record({ metrics: tokenUsageMetrics({ input: 200 }, { input_tokens: '0.000007' }) }));
    const [row] = await query(repo);
    assertEquals(tokenCountsFromUsage(row), { input: 300 });
    assertEquals(tokenRatesFromUsage(row), null);
  });

  test(`${backend.name} usage repo preserves fractional quantities`, async () => {
    const repo = await backend.make();
    await repo.usage.record(record({
      metrics: [{ metric: 'input_tokens', quantity: '90.5', unitPrice: '0.0000006' }],
    }));
    const [row] = await query(repo);
    assertEquals(row.metrics, [{ metric: 'input_tokens', quantity: '90.5', unitPrice: '0.0000006' }]);
  });

  test(`${backend.name} usage repo preserves audio duration seconds`, async () => {
    const repo = await backend.make();
    await repo.usage.record(record({
      metrics: [{ metric: 'input_audio_seconds', quantity: '90.5', unitPrice: '0.01' }],
    }));
    const [row] = await query(repo);
    assertEquals(row.metrics, [{ metric: 'input_audio_seconds', quantity: '90.5', unitPrice: '0.01' }]);
  });
  test(`${backend.name} usage repo preserves an explicitly measured zero`, async () => {
    const repo = await backend.make();
    await repo.usage.record(record({ metrics: tokenUsageMetrics({ input: 0 }, { input_tokens: '0.000002' }) }));
    const [row] = await query(repo);
    assertEquals(row.metrics, [{ metric: 'input_tokens', quantity: '0', unitPrice: '0.000002' }]);
  });

  test(`${backend.name} usage repo rejects duplicate metric rows`, async () => {
    const repo = await backend.make();
    await assertRejects(() => repo.usage.set(record({
      metrics: [
        { metric: 'input_tokens', quantity: '1', unitPrice: null },
        { metric: 'input_tokens', quantity: '2', unitPrice: null },
      ],
    })), Error, 'Duplicate usage metric: input_tokens');
  });

  test(`${backend.name} usage repo rejects noncanonical decimal rows`, async () => {
    const repo = await backend.make();
    await assertRejects(() => repo.usage.set(record({
      metrics: [{ metric: 'input_tokens', quantity: '01.0', unitPrice: '0.0000020' }],
    })), TypeError, 'quantity must be canonical');
  });

  test(`${backend.name} usage repo retains the request when metric persistence fails`, async () => {
    const repo = await backend.make();
    await assertRejects(() => repo.usage.record(record({
      metrics: [{ metric: 'input_tokens', quantity: '01.0', unitPrice: null }],
    })), TypeError, 'quantity must be canonical');
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
  await assertRejects(() => new SqlRepo(db).usage.listAll(), TypeError, 'usage.metric is invalid: "reasoning"');
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

test('SQL usage key scopes use key-hour range indexes in both storage tables', async () => {
  const db = await createSqliteTestDb();
  const seedRepo = new SqlRepo(db);
  await Promise.all([
    seedRepo.usage.record(record({ keyId: 'key-1' })),
    seedRepo.usage.record(record({ keyId: 'key-2' })),
  ]);
  const captured: CapturedStatement[] = [];
  const repo = new SqlRepo(recordBoundStatements(db, captured));

  const rows = await repo.usage.query({ keyIds: ['key-2'], start: '2026-07-12T00', end: '2026-07-12T01' });

  assertEquals(rows.map(row => row.keyId), ['key-2']);
  const usageQueries = captured.filter(statement => statement.query.includes('FROM usage'));
  assertEquals(usageQueries.length, 2);
  const plans = await Promise.all(usageQueries.map(async statement => {
    const { results } = await db.prepare(`EXPLAIN QUERY PLAN ${statement.query}`)
      .bind(...statement.binds)
      .all<{ detail: string }>();
    return results.map(row => row.detail).join('\n');
  }));
  assertEquals(plans.some(plan => plan.includes('idx_usage_metric_key_hour')), true);
  assertEquals(plans.some(plan => plan.includes('idx_usage_requests_key_hour')), true);
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
    start: '2026-11-01T05',
    end: '2026-11-01T08',
    groupBy: 'model',
    filters: { keyIds: [], userIds: [], models: ['model-a', 'model-b'], upstreams: ['none'] },
    keyToUser: new Map([['key-1', 1], ['key-2', 2]]),
    bucketForHour: hour => hour === '2026-11-01T05' || hour === '2026-11-01T06'
      ? '2026-11-01T01'
      : '2026-11-01T02',
  };

  for (const groupBy of ['model', 'upstream', 'userId', 'keyId'] as const) {
    const unfiltered = {
      ...options,
      groupBy,
      filters: { keyIds: [], userIds: [], models: [], upstreams: [] },
    };
    assertEquals(
      await sql.usage.queryOverview(unfiltered),
      await memory.usage.queryOverview(unfiltered),
    );
  }

  const expected = await memory.usage.queryOverview(options);
  const actual = await sql.usage.queryOverview(options);

  assertEquals(actual, expected);
  assertEquals(actual.dimensionValues, {
    keyIds: ['key-1'],
    userIds: [0, 1, 2],
    models: ['model-a', 'model-b'],
    upstreams: ['none', 'upstream:none'],
  });
  assertEquals(actual.axes.none[0], {
    bucket: 'all',
    group: 'all',
    requests: 11,
    metrics: [{ metric: 'input_tokens', quantity: '9007199254740992.1' }],
    cost: '900719925.4940992',
  });
});

test('SQL usage overview uses key-hour indexes for an actor-scoped aggregate', async () => {
  const db = await createSqliteTestDb();
  const seedRepo = new SqlRepo(db);
  await seedRepo.apiKeys.save(apiKey('key-1', 1));
  await seedRepo.usage.set(record({ keyId: 'key-1' }));
  const captured: CapturedStatement[] = [];
  const repo = new SqlRepo(recordBoundStatements(db, captured));

  await repo.usage.queryOverview({
    actorUserId: 1,
    isAdmin: true,
    start: '2026-07-12T00',
    end: '2026-07-12T01',
    groupBy: 'keyId',
    filters: { keyIds: [], userIds: [], models: [], upstreams: [] },
    keyToUser: new Map([['key-1', 1]]),
    bucketForHour: hour => hour,
  });

  const statement = captured.find(candidate => candidate.query.startsWith('/* usage-overview */'));
  if (!statement) throw new Error('Usage overview SQL was not captured');
  const { results } = await db.prepare(`EXPLAIN QUERY PLAN ${statement.query}`)
    .bind(...statement.binds)
    .all<{ detail: string }>();
  const plan = results.map(row => row.detail).join('\n');
  assertEquals(plan.includes('idx_usage_metric_key_hour'), true);
  assertEquals(plan.includes('idx_usage_requests_key_hour'), true);
});
