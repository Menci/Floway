import { describe, expect, test } from 'vitest';

import { assertCodexUpstreamRecord } from './config.ts';
import type { UpstreamRecord } from '@floway-dev/provider';

const goodAccount = { email: 'a@b.com', chatgptAccountId: 'a', chatgptUserId: 'u', planType: 'plus' };
const good = { accounts: [goodAccount] };

const wrap = (config: unknown): UpstreamRecord => ({
  id: 'up', kind: 'codex', name: 'n', enabled: true, sortOrder: 0,
  createdAt: '', updatedAt: '', config: config as UpstreamRecord['config'], state: null,
  flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [], modelPrefix: null,
});

describe('assertCodexUpstreamRecord (config validation)', () => {
  test('accepts a complete config', () => {
    expect(() => assertCodexUpstreamRecord(wrap(good))).not.toThrow();
  });
  test.each([
    ['email empty', { accounts: [{ ...goodAccount, email: '' }] }],
    ['email type', { accounts: [{ ...goodAccount, email: 123 }] }],
    ['account id missing', { accounts: [{ ...goodAccount, chatgptAccountId: undefined }] }],
    ['user id missing', { accounts: [{ ...goodAccount, chatgptUserId: '' }] }],
    ['planType missing', { accounts: [{ ...goodAccount, planType: undefined }] }],
    ['extra unknown field on account', { accounts: [{ ...goodAccount, extra: 1 }] }],
    ['extra unknown field at top level', { ...good, extra: 1 }],
    ['accounts not an array', { accounts: goodAccount }],
    ['empty accounts array', { accounts: [] }],
    ['multiple accounts (v1 invariant)', { accounts: [goodAccount, { ...goodAccount, chatgptAccountId: 'b' }] }],
  ])('rejects %s', (_label, value) => {
    expect(() => assertCodexUpstreamRecord(wrap(value))).toThrow();
  });
  test('rejects null / non-object configs', () => {
    expect(() => assertCodexUpstreamRecord(wrap(null))).toThrow();
    expect(() => assertCodexUpstreamRecord(wrap('a'))).toThrow();
    expect(() => assertCodexUpstreamRecord(wrap([]))).toThrow();
  });
});

describe('assertCodexUpstreamRecord (record-level checks)', () => {
  test('rejects non-codex record', () => {
    const record: UpstreamRecord = {
      id: 'up', kind: 'copilot', name: 'n', enabled: true, sortOrder: 0,
      createdAt: '', updatedAt: '', config: {}, state: null,
      flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [], modelPrefix: null,
    };
    expect(() => assertCodexUpstreamRecord(record)).toThrow();
  });
});
