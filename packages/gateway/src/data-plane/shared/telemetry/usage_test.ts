import { test } from 'vitest';

import { recordUsage } from './usage.ts';
import { initRepo } from '../../../repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { basePricing } from '@floway-dev/protocols/common';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

test('recordUsage persists caller-supplied quantities and units with resolved prices', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);

  await recordUsage(
    'key-a',
    {
      model: 'transcribe-model',
      upstream: 'upstream-a',
      modelKey: 'transcribe-model',
      pricing: basePricing({ input: 'minutes' }, { input: 0.6 }),
    },
    { input: 90 },
    { input: 'minutes' },
    { inputTokens: 0 },
  );

  const rows = await repo.usage.listAll();
  assertEquals(rows.length, 1);
  assertEquals(rows[0].requests, 1);
  assertEquals(rows[0].dimensions, [{ dimension: 'input', unit: 'minutes', quantity: 90, unitPrice: 0.6 }]);
});

test('recordUsage rejects a measured unit that disagrees with model pricing', async () => {
  initRepo(new InMemoryRepo());

  await assertRejects(
    () => recordUsage(
      'key-a',
      {
        model: 'rerank-model',
        upstream: 'upstream-a',
        modelKey: 'rerank-model',
        pricing: basePricing({ input: 'searches_1k' }, { input: 2 }),
      },
      { input: 1 },
      { input: 'tokens_1m' },
      { inputTokens: 0 },
    ),
    Error,
    'measured in tokens_1m but priced in searches_1k',
  );
});
