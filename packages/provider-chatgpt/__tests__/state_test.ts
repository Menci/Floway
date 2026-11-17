import { describe, expect, test } from 'vitest';

import { assertChatGPTUpstreamState, readChatGPTUpstreamState } from '../src/state.ts';

const goodAccount = { chatgptAccountId: 'acc_x', refresh_token: 'rt_x', state: 'active' as const, state_updated_at: '2026-01-01T00:00:00Z', openaiDeviceId: '11111111-2222-4333-8444-555555555555' };

describe('assertChatGPTUpstreamState', () => {
  test('accepts null refresh_token and rejects an empty string', () => {
    expect(() => assertChatGPTUpstreamState({ accounts: [{ ...goodAccount, refresh_token: null }] })).not.toThrow();
    expect(() => assertChatGPTUpstreamState({ accounts: [{ ...goodAccount, refresh_token: '' }] })).toThrow(/refresh_token/);
  });
  test('accepts a null chatgptAccountId and rejects missing or empty values', () => {
    expect(() => assertChatGPTUpstreamState({
      accounts: [{ ...goodAccount, chatgptAccountId: null }],
    })).not.toThrow();
    expect(() => assertChatGPTUpstreamState({
      accounts: [{ ...goodAccount, chatgptAccountId: undefined }],
    })).toThrow(/chatgptAccountId/);
    expect(() => assertChatGPTUpstreamState({
      accounts: [{ ...goodAccount, chatgptAccountId: '' }],
    })).toThrow(/chatgptAccountId/);
  });
  // A key that also names an Object.prototype member is still an unknown key.
  // `__proto__` only survives as an own property through JSON.parse, so every
  // case is built that way for uniformity.
  test('rejects prototype-named keys at every guarded level', () => {
    const withKey = (target: object, key: string): unknown =>
      JSON.parse(`${JSON.stringify(target).slice(0, -1)},"${key}":1}`);
    for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      const account = { ...goodAccount, accessToken: null, quotaSnapshot: null };
      expect(() => assertChatGPTUpstreamState(withKey({ accounts: [account] }, key))).toThrow(new RegExp(key));
      expect(() => assertChatGPTUpstreamState({ accounts: [withKey(account, key)] })).toThrow(new RegExp(key));
      expect(() => assertChatGPTUpstreamState({
        accounts: [{ ...goodAccount, accessToken: withKey({ token: 't', expiresAt: 1, refreshedAt: 1 }, key) }],
      })).toThrow(new RegExp(key));
      expect(() => assertChatGPTUpstreamState({
        accounts: [{ ...goodAccount, quotaSnapshot: { primary: withKey({ fetchedAt: 1, data: {} }, key) } }],
      })).toThrow(new RegExp(key));
    }
  });
  test('rejects an empty accounts array (v1 invariant: exactly one)', () => {
    expect(() => assertChatGPTUpstreamState({ accounts: [] })).toThrow(/exactly one/);
  });
  test('rejects malformed accessToken', () => {
    expect(() => assertChatGPTUpstreamState({
      accounts: [{ ...goodAccount, accessToken: { token: '', expiresAt: 1, refreshedAt: 'x' } }],
    })).toThrow(/token/);
    expect(() => assertChatGPTUpstreamState({
      accounts: [{ ...goodAccount, accessToken: { token: 'at', expiresAt: 'soon', refreshedAt: 'x' } }],
    })).toThrow(/expiresAt/);
    expect(() => assertChatGPTUpstreamState({
      accounts: [{ ...goodAccount, accessToken: { token: 'at', expiresAt: 1, refreshedAt: 'x', extra: 1 } }],
    })).toThrow(/extra/);
    expect(() => assertChatGPTUpstreamState({
      accounts: [{ ...goodAccount, accessToken: { token: 'at', expiresAt: 1, refreshedAt: 'x', planType: '' } }],
    })).toThrow(/planType/);
    expect(() => assertChatGPTUpstreamState({
      accounts: [{ ...goodAccount, accessToken: { token: 'at', expiresAt: 1, refreshedAt: 'x', planObservedAt: 'x' } }],
    })).toThrow(/requires planType/);
  });
  test('rejects malformed quotaSnapshot', () => {
    expect(() => assertChatGPTUpstreamState({
      accounts: [{ ...goodAccount, quotaSnapshot: { premium: { fetchedAt: 'soon', data: {} } } }],
    })).toThrow(/fetchedAt/);
    expect(() => assertChatGPTUpstreamState({
      accounts: [{ ...goodAccount, quotaSnapshot: { premium: { fetchedAt: 1, data: 'oops' } } }],
    })).toThrow(/data/);
    expect(() => assertChatGPTUpstreamState({
      accounts: [{ ...goodAccount, quotaSnapshot: { premium: { fetchedAt: 1, data: {}, extra: 1 } } }],
    })).toThrow(/extra/);
    expect(() => assertChatGPTUpstreamState({
      accounts: [{ ...goodAccount, quotaSnapshot: { premium: 123 } }],
    })).toThrow(/premium/);
    expect(() => assertChatGPTUpstreamState({
      accounts: [{ ...goodAccount, quotaSnapshot: { '': { fetchedAt: 1, data: {} } } }],
    })).toThrow(/invalid active limit key/);
    expect(() => assertChatGPTUpstreamState({
      accounts: [{ ...goodAccount, quotaSnapshot: { constructor: { fetchedAt: 1, data: {} } } }],
    })).toThrow(/invalid active limit key/);
  });
});

describe('readChatGPTUpstreamState', () => {
  test('normalizes absent accessToken / quotaSnapshot to null', () => {
    const fresh = { chatgptAccountId: 'acc_x', refresh_token: 'rt_x', state: 'active' as const, state_updated_at: '2026-01-01T00:00:00Z', openaiDeviceId: '11111111-2222-4333-8444-555555555555' };
    const out = readChatGPTUpstreamState({ accounts: [fresh] });
    expect(out.accounts[0].accessToken).toBeNull();
    expect(out.accounts[0].quotaSnapshot).toBeNull();
  });
});
