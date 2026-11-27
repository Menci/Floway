import { expect, test } from 'vitest';

import { CREDIT_BALANCE, LEGACY_BALANCE, USAGE_TOTALS, accountUsage } from './usage-fixture.ts';
import { readOllamaAccountUsage } from '../src/account-usage.ts';

test('billing mode comes from the current balance shape', () => {
  expect(readOllamaAccountUsage(accountUsage()).included).toEqual({ kind: 'credits', balanceUsd: 18, allowanceUsd: 60, from: '2026-10-01T00:00:00Z', until: '2026-11-01T00:00:00Z' });
  const legacy = readOllamaAccountUsage({ balance: LEGACY_BALANCE, usage: { ...USAGE_TOTALS, totals: { request_count: 15 } } });
  expect(legacy.included).toEqual({ kind: 'legacy', session: { remainingPercent: 75, resetsAt: '2026-10-11T09:00:00Z' }, weekly: { remainingPercent: 60, resetsAt: '2026-10-15T04:00:00Z' } });
  expect(legacy.activity.usageUsd).toBeNull();
  expect(legacy.purchasedBalanceUsd).toBe(25);
});

test.each([
  { included: { ...CREDIT_BALANCE.included, ...LEGACY_BALANCE.included }, purchased: { balance_usd: 25 } },
  { ...LEGACY_BALANCE, included: { ...LEGACY_BALANCE.included, session: { remaining_percent: 101, resets_at: '2026-10-11T09:00:00Z' } } },
])('malformed balances fail the complete account reading: %j', balance => {
  expect(() => readOllamaAccountUsage({ ...accountUsage(), balance })).toThrow();
});
