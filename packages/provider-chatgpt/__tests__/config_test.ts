import { describe, expect, test } from 'vitest';

import { assertChatGPTUpstreamRecord, patchChatGPTIdentityMetadata, type ChatGPTUpstreamConfig } from '../src/config.ts';
import type { UpstreamRecord } from '@floway-dev/provider';

const goodAccount = { email: 'a@b.com', chatgptAccountId: 'a', chatgptUserId: 'u', planType: 'plus' };
const good: ChatGPTUpstreamConfig = { accounts: [goodAccount] };

const wrap = (config: unknown): UpstreamRecord => ({
  id: 'up', kind: 'chatgpt', name: 'n', enabled: true, usageRefreshIntervalMinutes: 0, sortOrder: 0,
  createdAt: '', updatedAt: '', config: config as UpstreamRecord['config'], state: null,
  flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [], modelPrefix: null, modelsCache: null, hue: 210,
});

describe('assertChatGPTUpstreamRecord (config validation)', () => {
  test('accepts complete identity or explicitly null identity fields', () => {
    expect(() => assertChatGPTUpstreamRecord(wrap(good))).not.toThrow();
    expect(() => assertChatGPTUpstreamRecord(wrap({
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
    expect(() => assertChatGPTUpstreamRecord(wrap(value))).toThrow();
  });
  test('rejects null / non-object configs', () => {
    expect(() => assertChatGPTUpstreamRecord(wrap(null))).toThrow();
    expect(() => assertChatGPTUpstreamRecord(wrap('a'))).toThrow();
    expect(() => assertChatGPTUpstreamRecord(wrap([]))).toThrow();
  });
});

describe('assertChatGPTUpstreamRecord (record-level checks)', () => {
  test('rejects non-ChatGPT record', () => {
    const record: UpstreamRecord = {
      id: 'up', kind: 'copilot', name: 'n', enabled: true, usageRefreshIntervalMinutes: 0, sortOrder: 0,
      createdAt: '', updatedAt: '', config: {}, state: null,
      flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [], modelPrefix: null, modelsCache: null, hue: 210,
    };
    expect(() => assertChatGPTUpstreamRecord(record)).toThrow();
  });
});

describe('patchChatGPTIdentityMetadata', () => {
  test('updates nullable display metadata while retaining the account ID', () => {
    expect(patchChatGPTIdentityMetadata(good, {
      accounts: [{ email: null, chatgptAccountId: 'a', planType: 'pro' }],
    })).toEqual({
      accounts: [{ email: null, chatgptAccountId: 'a', chatgptUserId: 'u', planType: 'pro' }],
    });
  });

  test('preserves a null account ID and rejects account ID changes', () => {
    const withoutAccountId: ChatGPTUpstreamConfig = {
      accounts: [{ ...goodAccount, chatgptAccountId: null }],
    };
    expect(patchChatGPTIdentityMetadata(withoutAccountId, {
      accounts: [{ chatgptAccountId: null, email: null }],
    }).accounts[0].chatgptAccountId).toBeNull();
    expect(() => patchChatGPTIdentityMetadata(withoutAccountId, {
      accounts: [{ chatgptAccountId: 'other' }],
    })).toThrow(/only be changed by re-importing/);
    expect(() => patchChatGPTIdentityMetadata(good, {
      accounts: [{ chatgptAccountId: null }],
    })).toThrow(/only be changed by re-importing/);
  });

  test.each([
    ['unknown top-level field', { accessToken: 'secret' }],
    ['unknown account field', { accounts: [{ refresh_token: 'secret' }] }],
    ['multiple accounts', { accounts: [goodAccount, goodAccount] }],
    ['invalid metadata', { accounts: [{ email: '' }] }],
  ])('rejects %s', (_label, patch) => {
    expect(() => patchChatGPTIdentityMetadata(good, patch)).toThrow();
  });
});
