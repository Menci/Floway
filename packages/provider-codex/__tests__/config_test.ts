import { describe, expect, test } from 'vitest';

import { assertCodexUpstreamRecord, patchCodexIdentityMetadata, type CodexUpstreamConfig } from '../src/config.ts';
import type { UpstreamRecord } from '@floway-dev/provider';

const goodAccount = { email: 'a@b.com', chatgptAccountId: 'a', chatgptUserId: 'u', planType: 'plus' };
const good: CodexUpstreamConfig = { accounts: [goodAccount] };

const wrap = (config: unknown): UpstreamRecord => ({
  id: 'up', kind: 'codex', name: 'n', enabled: true, sortOrder: 0,
  createdAt: '', updatedAt: '', config: config as UpstreamRecord['config'], state: null,
  flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [], modelPrefix: null, modelsCache: null, hue: 210,
});

describe('assertCodexUpstreamRecord (config validation)', () => {
  test('accepts complete identity or explicitly null identity fields', () => {
    expect(() => assertCodexUpstreamRecord(wrap(good))).not.toThrow();
    expect(() => assertCodexUpstreamRecord(wrap({
      accounts: [{ email: null, chatgptAccountId: null, chatgptUserId: null, planType: null }],
    }))).not.toThrow();
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
      flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [], modelPrefix: null, modelsCache: null, hue: 210,
    };
    expect(() => assertCodexUpstreamRecord(record)).toThrow();
  });
});

describe('patchCodexIdentityMetadata', () => {
  test('updates nullable display metadata while retaining the account ID', () => {
    expect(patchCodexIdentityMetadata(good, {
      accounts: [{ email: null, chatgptAccountId: 'a', planType: 'pro' }],
    })).toEqual({
      accounts: [{ email: null, chatgptAccountId: 'a', chatgptUserId: 'u', planType: 'pro' }],
    });
  });

  test('preserves a null account ID and rejects account ID changes', () => {
    const withoutAccountId: CodexUpstreamConfig = {
      accounts: [{ ...goodAccount, chatgptAccountId: null }],
    };
    expect(patchCodexIdentityMetadata(withoutAccountId, {
      accounts: [{ chatgptAccountId: null, email: null }],
    }).accounts[0].chatgptAccountId).toBeNull();
    expect(() => patchCodexIdentityMetadata(withoutAccountId, {
      accounts: [{ chatgptAccountId: 'other' }],
    })).toThrow(/only be changed by re-importing/);
    expect(() => patchCodexIdentityMetadata(good, {
      accounts: [{ chatgptAccountId: null }],
    })).toThrow(/only be changed by re-importing/);
  });

  test.each([
    ['unknown top-level field', { accessToken: 'secret' }],
    ['unknown account field', { accounts: [{ refresh_token: 'secret' }] }],
    ['multiple accounts', { accounts: [goodAccount, goodAccount] }],
    ['invalid metadata', { accounts: [{ email: '' }] }],
  ])('rejects %s', (_label, patch) => {
    expect(() => patchCodexIdentityMetadata(good, patch)).toThrow();
  });
});
