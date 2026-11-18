import { expect, test } from 'vitest';

import { LEGACY_BALANCE, USAGE_TOTALS, accountUsage } from './usage-fixture.ts';
import { ollamaMetrics } from '../src/upstream-metrics.ts';

test('credit balances and period consumption retain distinct money gauges', () => {
  expect(ollamaMetrics(accountUsage())).toEqual([
    { name: 'balance.usd', labels: { source: 'included' }, value: 18 },
    { name: 'allowance.usd', labels: { source: 'included' }, value: 60 },
    { name: 'balance.usd', labels: { source: 'purchased' }, value: 25 },
    { name: 'activity.cost_usd', labels: { range: '7d' }, value: 3.25 },
  ]);
});

test('legacy plans retain percentage gauges and omit monetary usage when not supplied', () => {
  expect(ollamaMetrics({ balance: LEGACY_BALANCE, usage: { ...USAGE_TOTALS, totals: { request_count: 15 } } })).toEqual([
    { name: 'quota.remaining_percent', labels: { window: 'session' }, value: 75 },
    { name: 'quota.remaining_percent', labels: { window: 'weekly' }, value: 60 },
    { name: 'balance.usd', labels: { source: 'purchased' }, value: 25 },
  ]);
});
