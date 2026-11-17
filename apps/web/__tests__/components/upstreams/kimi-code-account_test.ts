import { expect, test } from 'vitest';

import { kimiCodeRecord } from './kimi-code-fixture';
import { kimiCodeAccount, kimiCodeAccountName, kimiCodePlanLabel } from '../../../src/components/upstreams/kimi-code-account';

test('account identity is optional and empty names retain a readable identity', () => {
  const record = kimiCodeRecord();
  expect(kimiCodeAccount(record)).toBeNull();
  expect(kimiCodePlanLabel(record)).toBeNull();
  const account = { userId: 'fake-user', globalId: null, nickname: '', status: '', region: '', userLevel: 0, userLevelName: 'Allegretto', domain: 0, domainName: '', goodsVersion: null, username: null, email: null, bio: null, avatar: null, phone: null, createdTime: null, lastLoginTime: null };
  record.state!.accountProbe = { attemptedAt: 1000, observation: { fetchedAt: 1000, data: account }, error: null };
  expect(kimiCodeAccountName(account)).toBe('fake-user');
  expect(kimiCodeAccountName({ ...account, nickname: 'Operator' })).toBe('Operator');
  expect(kimiCodePlanLabel(record)).toBe('Kimi Allegretto');
  account.userLevelName = '';
  expect(kimiCodePlanLabel(record)).toBeNull();
});
