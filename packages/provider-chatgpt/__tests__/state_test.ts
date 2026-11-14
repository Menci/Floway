import { describe, expect, test } from 'vitest';

import { assertChatGPTUpstreamState, readChatGPTUpstreamState, type ChatGPTUpstreamState } from '../src/state.ts';

const goodAccount = { chatgptAccountId: 'acc_x', refresh_token: 'rt_x', state: 'active' as const, state_updated_at: '2026-01-01T00:00:00Z', openaiDeviceId: '11111111-2222-4333-8444-555555555555' };
const good: ChatGPTUpstreamState = { accounts: [{ ...goodAccount, accessToken: null, quotaSnapshot: null }] };

describe('assertChatGPTUpstreamState', () => {
  test('accepts active state', () => {
    expect(() => assertChatGPTUpstreamState(good)).not.toThrow();
  });
  test('accepts terminal states with state_message', () => {
    expect(() => assertChatGPTUpstreamState({
      accounts: [{
        chatgptAccountId: 'acc_x',
        refresh_token: 'rt_x',
        state: 'session_terminated',
        state_message: 'Token revoked',
        state_updated_at: '2026-06-05T00:00:00.000Z',
        openaiDeviceId: '11111111-2222-4333-8444-555555555555',
      }],
    })).not.toThrow();
    expect(() => assertChatGPTUpstreamState({
      accounts: [{ chatgptAccountId: 'acc_x', refresh_token: 'rt_x', state: 'refresh_failed', state_updated_at: '2026-06-05T00:00:00.000Z', openaiDeviceId: '11111111-2222-4333-8444-555555555555' }],
    })).not.toThrow();
  });
  test('rejects missing state_updated_at', () => {
    const { state_updated_at: _drop, ...withoutTimestamp } = goodAccount;
    expect(() => assertChatGPTUpstreamState({ accounts: [withoutTimestamp] })).toThrow(/state_updated_at/);
  });
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
  test('rejects unknown state value', () => {
    expect(() => assertChatGPTUpstreamState({ accounts: [{ ...goodAccount, state: 'broken' }] })).toThrow(/state/);
  });
  test('rejects null / undefined / non-objects', () => {
    expect(() => assertChatGPTUpstreamState(null)).toThrow();
    expect(() => assertChatGPTUpstreamState(undefined)).toThrow();
    expect(() => assertChatGPTUpstreamState('s')).toThrow();
  });
  test('rejects unexpected keys at the top level', () => {
    expect(() => assertChatGPTUpstreamState({ ...good, extra_field: 'x' })).toThrow(/extra_field/);
  });
  test('rejects unexpected keys inside an account', () => {
    expect(() => assertChatGPTUpstreamState({ accounts: [{ ...goodAccount, smuggled: 'x' }] })).toThrow(/smuggled/);
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
  test('rejects multiple accounts (v1 invariant: exactly one)', () => {
    expect(() => assertChatGPTUpstreamState({ accounts: [goodAccount, { ...goodAccount, chatgptAccountId: 'acc_y' }] })).toThrow(/exactly one/);
  });

  test('accepts accessToken absent, null, unknown-expiry, populated, or plan-observed', () => {
    expect(() => assertChatGPTUpstreamState({ accounts: [{ ...goodAccount }] })).not.toThrow();
    expect(() => assertChatGPTUpstreamState({ accounts: [{ ...goodAccount, accessToken: null }] })).not.toThrow();
    expect(() => assertChatGPTUpstreamState({
      accounts: [{ ...goodAccount, accessToken: { token: 'at', expiresAt: null, refreshedAt: '2026-06-05T00:00:00Z' } }],
    })).not.toThrow();
    expect(() => assertChatGPTUpstreamState({
      accounts: [{ ...goodAccount, accessToken: { token: 'at', expiresAt: 1_700_000_000_000, refreshedAt: '2026-06-05T00:00:00Z' } }],
    })).not.toThrow();
    expect(() => assertChatGPTUpstreamState({
      accounts: [{ ...goodAccount, accessToken: { token: 'at', expiresAt: 1_700_000_000_000, refreshedAt: '2026-06-05T00:00:00Z', planType: 'plus' } }],
    })).not.toThrow();
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

  test('accepts quotaSnapshot absent / null / populated', () => {
    expect(() => assertChatGPTUpstreamState({ accounts: [{ ...goodAccount, quotaSnapshot: null }] })).not.toThrow();
    expect(() => assertChatGPTUpstreamState({
      accounts: [{
        ...goodAccount,
        quotaSnapshot: { premium: { fetchedAt: 1_700_000_000_000, data: { observed_at: '2026-06-05T00:00:00Z' } } },
      }],
    })).not.toThrow();
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

  test('rejects missing / empty openaiDeviceId', () => {
    const { openaiDeviceId: _drop, ...withoutDeviceId } = goodAccount;
    expect(() => assertChatGPTUpstreamState({ accounts: [withoutDeviceId] })).toThrow(/openaiDeviceId/);
    expect(() => assertChatGPTUpstreamState({ accounts: [{ ...goodAccount, openaiDeviceId: '' }] })).toThrow(/openaiDeviceId/);
    expect(() => assertChatGPTUpstreamState({ accounts: [{ ...goodAccount, openaiDeviceId: 42 }] })).toThrow(/openaiDeviceId/);
  });
});

describe('readChatGPTUpstreamState', () => {
  test('normalizes absent accessToken / quotaSnapshot to null', () => {
    const fresh = { chatgptAccountId: 'acc_x', refresh_token: 'rt_x', state: 'active' as const, state_updated_at: '2026-01-01T00:00:00Z', openaiDeviceId: '11111111-2222-4333-8444-555555555555' };
    const out = readChatGPTUpstreamState({ accounts: [fresh] });
    expect(out.accounts[0].accessToken).toBeNull();
    expect(out.accounts[0].quotaSnapshot).toBeNull();
  });
  test('preserves populated entries verbatim', () => {
    const populated = {
      accounts: [{
        ...goodAccount,
        accessToken: { token: 'at', expiresAt: 1_700_000_000_000, refreshedAt: '2026-06-05T00:00:00Z' },
        quotaSnapshot: { premium: { fetchedAt: 1_700_000_000_000, data: { observed_at: '2026-06-05T00:00:00Z' } } },
      }],
    };
    const out = readChatGPTUpstreamState(populated);
    expect(out.accounts[0].accessToken).toEqual(populated.accounts[0].accessToken);
    expect(out.accounts[0].quotaSnapshot).toEqual(populated.accounts[0].quotaSnapshot);
  });
});
