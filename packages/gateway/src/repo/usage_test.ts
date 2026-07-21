import initSqlJs from 'sql.js';
import { test } from 'vitest';

import { InMemoryRepo } from './memory.ts';
import { SqlRepo } from './sql.ts';
import { createSqliteTestDb, migrationSqlByFilename } from './test-sqlite.ts';
import type { Repo, UsageRecord } from './types.ts';
import { tokenCountsFromUsage, tokenRatesFromUsage, tokenUsageMetrics } from './usage-metrics.ts';
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

const query = (repo: Repo) => repo.usage.query({ keyId: 'key-1', start: '2026-07-12T00', end: '2026-07-12T01' });

test('0052 preserves distinct open-string service tiers as canonical selectors', async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
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
    const SQL = await initSqlJs();
    const db = new SQL.Database();
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
