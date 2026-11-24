import { expect, it } from 'vitest';

import { createSqliteTestDb } from './test-sqlite.ts';
import { SqlRepo } from '../../src/repo/sql.ts';
import type { UsageRecord } from '../../src/repo/types.ts';

it('adds exact prices for only the requested upstream and interval, and rejects incomplete totals', async () => {
  const repo = new SqlRepo(await createSqliteTestDb());
  const start = '2026-11-18T00';
  const end = '2026-11-18T02';
  const usage: UsageRecord = {
    keyId: 'key', model: 'model', modelKey: 'model', upstream: 'up-1', hour: start,
    pricingSelector: {}, requests: 1, metrics: [
      { metric: 'input_tokens', quantity: '1', unitPrice: '0.1' },
      { metric: 'output_tokens', quantity: '0', unitPrice: null },
    ],
  };
  const cost = () => repo.usage.queryUpstreamCost('up-1', start, end);
  expect(await cost()).toBe('0');
  await repo.usage.set(usage);
  await repo.usage.set({ ...usage, hour: '2026-11-18T01' });
  await repo.usage.set({ ...usage, upstream: 'up-2', metrics: [] });
  await repo.usage.set({ ...usage, hour: end, metrics: [] });
  expect(await cost()).toBe('0.2');

  await repo.usage.set({ ...usage, model: 'missing', metrics: [] });
  expect(await cost()).toBeNull();
  await repo.usage.set({ ...usage, model: 'missing', metrics: [{ metric: 'input_tokens', quantity: '1', unitPrice: null }] });
  expect(await cost()).toBeNull();
  await repo.usage.set({ ...usage, model: 'missing', metrics: [{ metric: 'input_tokens', quantity: '9', unitPrice: '0.000001' }] });
  expect(await cost()).toBe('0.200009');
});
