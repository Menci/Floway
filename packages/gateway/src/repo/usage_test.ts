import { test } from 'vitest';

import { InMemoryRepo } from './memory.ts';
import { SqlRepo } from './sql.ts';
import { createSqliteTestDb } from './test-sqlite.ts';
import type { UsageRecord, UsageRepo } from './types.ts';
import type { ModelPricing } from '@floway-dev/protocols/common';
import { assertEquals } from '@floway-dev/test-utils';

// GPT-5.6-Sol-shaped snapshot: a >272k long-context tier doubles input/cache
// and lifts output. The base and long-context rows share every bucket key
// except `inputTier`, so they must never merge.
const GPT_56_SOL: ModelPricing = {
  input: 5,
  input_cache_read: 0.5,
  input_cache_write: 6.25,
  output: 30,
  inputLengthTiers: [{ minInputTokens: 272000, input: 10, input_cache_read: 1, input_cache_write: 12.5, output: 45 }],
};

const baseRecord = (overrides: Partial<UsageRecord>): UsageRecord => ({
  keyId: 'key-1',
  model: 'gpt-5.6-sol',
  upstream: 'up_codex',
  modelKey: 'gpt-5.6-sol',
  hour: '2026-07-01T10',
  tier: null,
  inputTier: null,
  requests: 1,
  tokens: { input: 1_000_000 },
  cost: GPT_56_SOL,
  ...overrides,
});

const byInputTier = (records: UsageRecord[]) => records.toSorted((a, b) => (a.inputTier ?? 0) - (b.inputTier ?? 0));

const exerciseInputTierBuckets = async (repo: UsageRepo) => {
  await repo.deleteAll();
  await repo.record(baseRecord({ inputTier: null }));
  await repo.record(baseRecord({ inputTier: null })); // sums into the base bucket
  await repo.record(baseRecord({ inputTier: 272000 }));

  const rows = byInputTier(await repo.listAll());
  assertEquals(rows.length, 2);

  // Base bucket: two requests summed, priced at the base input rate.
  assertEquals(rows[0].inputTier, null);
  assertEquals(rows[0].requests, 2);
  assertEquals(rows[0].tokens.input, 2_000_000);
  assertEquals(rows[0].cost?.input, 5);

  // Long-context bucket: separate row, priced at the >272k input rate.
  assertEquals(rows[1].inputTier, 272000);
  assertEquals(rows[1].requests, 1);
  assertEquals(rows[1].tokens.input, 1_000_000);
  assertEquals(rows[1].cost?.input, 10);

  await repo.deleteAll();
  assertEquals(await repo.listAll(), []);
};

test('memory usage repo keeps input-length tiers in disjoint buckets', async () => {
  await exerciseInputTierBuckets(new InMemoryRepo().usage);
});

test('SQL usage repo keeps input-length tiers in disjoint buckets through the migrated schema', async () => {
  await exerciseInputTierBuckets(new SqlRepo(await createSqliteTestDb()).usage);
});
