import { test } from 'vitest';

import { InMemoryRepo } from './memory.ts';
import { SqlRepo } from './sql.ts';
import { createSqliteTestDb } from './test-sqlite.ts';
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
  cost: longPricing,
  ...overrides,
});

const query = (repo: Repo) => repo.usage.query({ keyId: 'key-1', start: '2026-07-12T00', end: '2026-07-12T01' });

for (const backend of backends) {
  test(`${backend.name} usage repo folds the selected input-length cell into per-dimension unit prices at write time`, async () => {
    const repo = await backend.make();
    await repo.usage.record(record({ pricingSelector: { inputTokens: { operator: 'gt', value: 272000 } } }));
    const [row] = await query(repo);
    assertEquals(row.pricingSelector, { inputTokens: { operator: 'gt', value: 272000 } });
    // The whole bucket is priced at the long-band rates, not the base rates.
    // Only dimensions that carry tokens get a unit-price snapshot.
    assertEquals(row.cost, { input: 10, input_cache_read: 1, output: 45 });
  });

  test(`${backend.name} usage repo keeps different input-length bands in separate buckets`, async () => {
    const repo = await backend.make();
    await repo.usage.record(record({ cost: { input: 5, input_cache_read: 0.5, output: 30 }, pricingSelector: {}, tokens: { input: 100, input_cache_read: 20, output: 50 } }));
    await repo.usage.record(record({ pricingSelector: { inputTokens: { operator: 'gt', value: 272000 } }, tokens: { input: 300_000, input_cache_read: 20_000, output: 100_000 } }));
    const rows = (await query(repo)).sort((a, b) => Object.keys(a.pricingSelector).length - Object.keys(b.pricingSelector).length);
    assertEquals(rows.length, 2);
    assertEquals(rows[0].pricingSelector, {});
    assertEquals(rows[0].cost, { input: 5, input_cache_read: 0.5, output: 30 });
    assertEquals(rows[1].pricingSelector, { inputTokens: { operator: 'gt', value: 272000 } });
    assertEquals(rows[1].cost, { input: 10, input_cache_read: 1, output: 45 });
  });

  test(`${backend.name} usage repo sums additive writes within one grid cell`, async () => {
    const repo = await backend.make();
    await repo.usage.record(record({ pricingSelector: { inputTokens: { operator: 'gt', value: 272000 } } }));
    await repo.usage.record(record({ pricingSelector: { inputTokens: { operator: 'gt', value: 272000 } } }));
    const rows = await query(repo);
    assertEquals(rows.length, 1);
    assertEquals(rows[0].tokens, { input: 600_000, input_cache_read: 40_000, output: 200_000 });
    assertEquals(rows[0].requests, 2);
  });

  test(`${backend.name} usage repo stores a missing (service tier × input length) combination as unpriced`, async () => {
    const repo = await backend.make();
    await repo.usage.record(record({ cost: null, pricingSelector: { inputTokens: { operator: 'gt', value: 272000 }, serviceTier: 'priority' } }));
    const [row] = await query(repo);
    // No priority-long cell exists, so no dimension resolves a unit price.
    assertEquals(row.cost, null);
  });
}
