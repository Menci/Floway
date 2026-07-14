import initSqlJs from 'sql.js';
import { test } from 'vitest';

import { InMemoryRepo } from './memory.ts';
import { SqlRepo } from './sql.ts';
import { createSqliteTestDb, migrationSqlByFilename } from './test-sqlite.ts';
import type { Repo, UsageRecord } from './types.ts';
import type { PriceVector } from '@floway-dev/protocols/common';
import { assertEquals } from '@floway-dev/test-utils';

// The usage repo threads the (service tier × input length) grid coordinate
// through persistence. These cases run against both backends — the SQL repo
// applies every migration (including canonical pricing selector storage) against a real sql.js database, and the in-memory repo mirrors the
// same bucket identity — so the two stay behaviorally identical.
const backends: { name: string; make: () => Promise<Repo> }[] = [
  { name: 'sql', make: async () => new SqlRepo(await createSqliteTestDb()) },
  { name: 'memory', make: () => Promise.resolve(new InMemoryRepo()) },
];

const longPricing: PriceVector = { input: 10, input_cache_read: 1, output: 45 };

const record = (overrides: Partial<UsageRecord>): UsageRecord => ({
  keyId: 'key-1',
  model: 'gpt-5.6-sol',
  upstream: 'up_codex',
  modelKey: 'gpt-5.6-sol',
  hour: '2026-07-12T00',
  pricingSelector: {},
  requests: 1,
  tokens: { input: 300_000, input_cache_read: 20_000, output: 100_000 },
  rates: longPricing,
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
        ('k', 'm', NULL, 'mk', '2026-01-01T00', 'pri"雪', 'input', 30, 3)`);
      db.run(`INSERT INTO usage_requests (key_id, model, upstream, model_key, hour, tier, requests) VALUES
        ('k', 'm', NULL, 'mk', '2026-01-01T00', NULL, 1),
        ('k', 'm', NULL, 'mk', '2026-01-01T00', '  ', 2),
        ('k', 'm', NULL, 'mk', '2026-01-01T00', 'pri"雪', 3)`);
    }
    db.run(sql);
  }
  const usageRows = db.exec('SELECT pricing_selector, tokens, unit_price FROM usage ORDER BY tokens')[0]!.values;
  const requestRows = db.exec('SELECT pricing_selector, requests FROM usage_requests ORDER BY requests')[0]!.values;
  assertEquals(usageRows, [
    ['{}', 10, 1],
    ['{"serviceTier":"  "}', 20, 2],
    ['{"serviceTier":"pri\\"雪"}', 30, 3],
  ]);
  assertEquals(requestRows, [
    ['{}', 1],
    ['{"serviceTier":"  "}', 2],
    ['{"serviceTier":"pri\\"雪"}', 3],
  ]);
});

for (const backend of backends) {
  test(`${backend.name} usage repo folds the selected input-length pricing entry into per-dimension unit prices at write time`, async () => {
    const repo = await backend.make();
    await repo.usage.record(record({ pricingSelector: { inputTokens: { operator: 'gt', value: 272000 } } }));
    const [row] = await query(repo);
    assertEquals(row.pricingSelector, { inputTokens: { operator: 'gt', value: 272000 } });
    // The whole bucket is priced at the long-band rates, not the base rates.
    // Only dimensions that carry tokens get a unit-price snapshot.
    assertEquals(row.rates, { input: 10, input_cache_read: 1, output: 45 });
  });

  test(`${backend.name} usage repo keeps different input-length bands in separate buckets`, async () => {
    const repo = await backend.make();
    await repo.usage.record(record({ rates: { input: 5, input_cache_read: 0.5, output: 30 }, pricingSelector: {}, tokens: { input: 100, input_cache_read: 20, output: 50 } }));
    await repo.usage.record(record({ pricingSelector: { inputTokens: { operator: 'gt', value: 272000 } }, tokens: { input: 300_000, input_cache_read: 20_000, output: 100_000 } }));
    const rows = (await query(repo)).sort((a, b) => Object.keys(a.pricingSelector).length - Object.keys(b.pricingSelector).length);
    assertEquals(rows.length, 2);
    assertEquals(rows[0].pricingSelector, {});
    assertEquals(rows[0].rates, { input: 5, input_cache_read: 0.5, output: 30 });
    assertEquals(rows[1].pricingSelector, { inputTokens: { operator: 'gt', value: 272000 } });
    assertEquals(rows[1].rates, { input: 10, input_cache_read: 1, output: 45 });
  });

  test(`${backend.name} usage repo sums additive writes within one pricing entry`, async () => {
    const repo = await backend.make();
    await repo.usage.record(record({ pricingSelector: { inputTokens: { operator: 'gt', value: 272000 } } }));
    await repo.usage.record(record({ pricingSelector: { inputTokens: { operator: 'gt', value: 272000 } } }));
    const rows = await query(repo);
    assertEquals(rows.length, 1);
    assertEquals(rows[0].tokens, { input: 600_000, input_cache_read: 40_000, output: 200_000 });
    assertEquals(rows[0].requests, 2);
  });

  test(`${backend.name} usage repo stores requests from models without pricing as unpriced`, async () => {
    const repo = await backend.make();
    await repo.usage.record(record({ rates: null, pricingSelector: {} }));
    const [row] = await query(repo);
    assertEquals(row.rates, null);
  });

  test(`${backend.name} usage repo keeps an unpriced first-write snapshot when later writes are priced`, async () => {
    const repo = await backend.make();
    await repo.usage.record(record({ rates: null, tokens: { input: 100 } }));
    await repo.usage.record(record({ rates: { input: 7 }, tokens: { input: 200 } }));
    const [row] = await query(repo);
    assertEquals(row.tokens, { input: 300 });
    assertEquals(row.rates, null);
  });
}
