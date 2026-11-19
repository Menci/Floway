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
    ['account id missing', { accounts: [{ ...goodAccount, chatgptAccountId: undefined }] }],
    ['multiple accounts (v1 invariant)', { accounts: [goodAccount, { ...goodAccount, chatgptAccountId: 'b' }] }],
  ])('rejects %s', (_label, value) => {
    expect(() => assertChatGPTUpstreamRecord(wrap(value))).toThrow();
  });
});

describe('patchChatGPTIdentityMetadata', () => {
  test('preserves a null account ID and rejects account ID changes', () => {
    const withoutAccountId: ChatGPTUpstreamConfig = {
      accounts: [{ ...goodAccount, chatgptAccountId: null }],
    };
    expect(patchChatGPTIdentityMetadata(withoutAccountId, {
      accounts: [{ chatgptAccountId: null, email: null }],
    }).accounts[0].chatgptAccountId).toBeNull();
    expect(() => patchChatGPTIdentityMetadata(withoutAccountId, {
      accounts: [{ chatgptAccountId: 'other' }],
    })).toThrow();
    expect(() => patchChatGPTIdentityMetadata(good, {
      accounts: [{ chatgptAccountId: null }],
    })).toThrow();
  });

  test.each([
    ['unknown account field', { accounts: [{ refresh_token: 'secret' }] }],
  ])('rejects %s', (_label, patch) => {
    expect(() => patchChatGPTIdentityMetadata(good, patch)).toThrow();
  });
});
