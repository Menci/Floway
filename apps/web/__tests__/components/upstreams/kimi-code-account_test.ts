import { expect, test } from 'vitest';

import { kimiCodeRecord } from './kimi-code-fixture';
import { kimiCodeAccount, kimiCodeAccountName, kimiCodePlanLabel, readKimiCodeWindows } from '../../../src/components/upstreams/kimi-code-account';

test('orders normalized quota windows without consulting a plan or wire fields', () => {
  expect(readKimiCodeWindows({
    windows: [
      { id: 'weekly', usedRatio: 0.5, resetsAt: '2026-12-01T00:00:00Z' },
      { id: 'monthly', usedRatio: 0.3, resetsAt: '2026-12-01T00:00:00Z' },
      { id: 'five_hour', usedRatio: 0.1, resetsAt: '2026-12-01T00:00:00Z' },
    ], monthlyCodeUsedRatio: 0.1,
  }).map(window => [window.id, window.percent])).toEqual([['five_hour', 10], ['monthly', 30], ['weekly', 50]]);
});

test('account identity is optional and empty names retain a readable identity', () => {
  const record = kimiCodeRecord();
  expect(kimiCodeAccount(record)).toBeNull();
  expect(kimiCodePlanLabel(record)).toBeNull();
  const account = { userId: 'fake-user', nickname: '', planName: 'Allegretto', goodsVersion: 1 };
  record.state!.accountProbe = { attemptedAt: 1000, observation: { fetchedAt: 1000, data: account }, error: null };
  expect(kimiCodeAccountName(account)).toBe('fake-user');
  expect(kimiCodeAccountName({ ...account, nickname: 'Operator' })).toBe('Operator');
  expect(kimiCodePlanLabel(record)).toBe('Allegretto');
});
