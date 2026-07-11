import { test } from 'vitest';

import { InMemoryRepo } from './memory.ts';
import { SqlRepo } from './sql.ts';
import { createSqliteTestDb } from './test-sqlite.ts';
import type { Repo, UsageRecord } from './types.ts';
import type { ModelPricing } from '@floway-dev/protocols/common';
import { assertEquals } from '@floway-dev/test-utils';

// The usage repo threads the (service tier × input length) grid coordinate
// through persistence. These cases run against both backends — the SQL repo
// applies every migration (including the input_above_tokens column and its
// CHECK) against a real sql.js database, and the in-memory repo mirrors the
// same bucket identity — so the two stay behaviorally identical.
const backends: { name: string; make: () => Promise<Repo> }[] = [
  { name: 'sql', make: async () => new SqlRepo(await createSqliteTestDb()) },
  { name: 'memory', make: () => Promise.resolve(new InMemoryRepo()) },
];

// A (service tier × input length) grid, modeled after GPT-5.6 Sol.
const gridPricing: ModelPricing = {
  input: 5, input_cache_read: 0.5, output: 30,
  tiers: { priority: { input: 10, input_cache_read: 1, output: 60 } },
  inputLengthTiers: [{
    aboveInputTokens: 272000,
    input: 10, input_cache_read: 1, output: 45,
    tiers: { priority: { input: 20, input_cache_read: 2, output: 90 } },
  }],
};

const record = (overrides: Partial<UsageRecord>): UsageRecord => ({
  keyId: 'key-1',
  model: 'gpt-5.6-sol',
  upstream: 'up_codex',
  modelKey: 'gpt-5.6-sol',
  hour: '2026-07-12T00',
  tier: null,
  inputAboveTokens: null,
  requests: 1,
  tokens: { input: 300_000, output: 100_000 },
  cost: gridPricing,
  ...overrides,
});

const query = (repo: Repo) => repo.usage.query({ keyId: 'key-1', start: '2026-07-12T00', end: '2026-07-12T01' });

for (const backend of backends) {
  test(`${backend.name} usage repo folds the selected input-length cell into per-dimension unit prices at write time`, async () => {
    const repo = await backend.make();
    await repo.usage.record(record({ inputAboveTokens: 272000 }));
    const [row] = await query(repo);
    assertEquals(row.inputAboveTokens, 272000);
    // The whole bucket is priced at the long-band rates, not the base rates.
    assertEquals(row.cost, { input: 10, input_cache_read: 1, output: 45 });
  });

  test(`${backend.name} usage repo keeps different input-length bands in separate buckets`, async () => {
    const repo = await backend.make();
    await repo.usage.record(record({ inputAboveTokens: null, tokens: { input: 100, output: 50 } }));
    await repo.usage.record(record({ inputAboveTokens: 272000, tokens: { input: 300_000, output: 100_000 } }));
    const rows = (await query(repo)).sort((a, b) => (a.inputAboveTokens ?? 0) - (b.inputAboveTokens ?? 0));
    assertEquals(rows.length, 2);
    assertEquals(rows[0].inputAboveTokens, null);
    assertEquals(rows[0].cost, { input: 5, output: 30 });
    assertEquals(rows[1].inputAboveTokens, 272000);
    assertEquals(rows[1].cost, { input: 10, input_cache_read: 1, output: 45 });
  });

  test(`${backend.name} usage repo sums additive writes within one grid cell`, async () => {
    const repo = await backend.make();
    await repo.usage.record(record({ inputAboveTokens: 272000, tokens: { input: 300_000, output: 100_000 } }));
    await repo.usage.record(record({ inputAboveTokens: 272000, tokens: { input: 300_000, output: 100_000 } }));
    const rows = await query(repo);
    assertEquals(rows.length, 1);
    assertEquals(rows[0].tokens, { input: 600_000, output: 200_000 });
    assertEquals(rows[0].requests, 2);
  });

  test(`${backend.name} usage repo stores a missing (service tier × input length) combination as unpriced`, async () => {
    const repo = await backend.make();
    const partialGrid: ModelPricing = {
      input: 5, output: 30,
      tiers: { priority: { input: 10, output: 60 } },
      inputLengthTiers: [{ aboveInputTokens: 272000, input: 10, output: 45 }],
    };
    await repo.usage.record(record({ cost: partialGrid, tier: 'priority', inputAboveTokens: 272000 }));
    const [row] = await query(repo);
    // No priority-long cell exists, so no dimension resolves a unit price.
    assertEquals(row.cost, null);
  });
}
