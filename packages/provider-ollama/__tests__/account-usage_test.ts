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

test('zero allowance and balances are valid readings', () => {
  expect(readOllamaAccountUsage(accountUsage({ ...CREDIT_BALANCE, included: { ...CREDIT_BALANCE.included, balance_usd: 0, allowance_usd: 0 }, purchased: { balance_usd: 0 } })).included).toMatchObject({ kind: 'credits', allowanceUsd: 0, balanceUsd: 0 });
});

test('finite signed balances and additional upstream fields are retained', () => {
  expect(readOllamaAccountUsage({ ...accountUsage(), balance: { ...CREDIT_BALANCE, purchased: { balance_usd: -1, extra: true } }, extra: true }).purchasedBalanceUsd).toBe(-1);
});

test.each([
  { included: {}, purchased: { balance_usd: 25 } },
  { included: { ...CREDIT_BALANCE.included, ...LEGACY_BALANCE.included }, purchased: { balance_usd: 25 } },
  { ...CREDIT_BALANCE, included: { ...CREDIT_BALANCE.included, period: { from: 'invalid', until: '2026-11-01T00:00:00Z' } } },
  { ...CREDIT_BALANCE, purchased: { balance_usd: Infinity } },
  { ...LEGACY_BALANCE, included: { ...LEGACY_BALANCE.included, session: { remaining_percent: 101, resets_at: '2026-10-11T09:00:00Z' } } },
])('malformed balances fail the complete account reading: %j', balance => {
  expect(() => readOllamaAccountUsage({ ...accountUsage(), balance })).toThrow();
});

test.each([{ request_count: -1 }, { request_count: 1.5 }, { request_count: 15, usage_usd: '3.25' }, { request_count: 15, usage_usd: NaN }])('malformed reporting totals fail: %j', totals => {
  expect(() => readOllamaAccountUsage({ balance: CREDIT_BALANCE, usage: { ...USAGE_TOTALS, totals } })).toThrow();
});
