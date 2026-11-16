import { expect, test } from 'vitest';

import { currentUsage, kimiCodeRecord, legacyUsage } from './kimi-code-fixture';
import { kimiCodeAccount, kimiCodeAccountName, kimiCodePlanLabel, readKimiCodeWindows } from '../../../src/components/upstreams/kimi-code-account';
import { readKimiCodeUsage } from '@floway-dev/provider-kimi-code/browser';

test.each([currentUsage, legacyUsage])('renders normalized quota windows in parser order', usage => {
  const normalized = readKimiCodeUsage(usage);
  expect(readKimiCodeWindows(normalized)).toEqual(normalized.windows.map(window => ({ ...window, percent: window.usedRatio * 100 })));
});

test('account identity is optional and empty names retain a readable identity', () => {
  const record = kimiCodeRecord();
  expect(kimiCodeAccount(record)).toBeNull();
  expect(kimiCodePlanLabel(record)).toBeNull();
  const account = { userId: 'fake-user', nickname: '', planName: 'Allegretto' };
  record.state!.accountProbe = { attemptedAt: 1000, observation: { fetchedAt: 1000, data: account }, error: null };
  expect(kimiCodeAccountName(account)).toBe('fake-user');
  expect(kimiCodeAccountName({ ...account, nickname: 'Operator' })).toBe('Operator');
  expect(kimiCodePlanLabel(record)).toBe('Allegretto');
});
