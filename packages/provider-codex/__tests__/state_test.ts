import { describe, expect, test } from 'vitest';

import { assertCodexUpstreamState, readCodexUpstreamState, type CodexUpstreamState } from '../src/state.ts';

const goodAccount = { chatgptAccountId: 'acc_x', refresh_token: 'rt_x', state: 'active' as const, state_updated_at: '2026-01-01T00:00:00Z', openaiDeviceId: '11111111-2222-4333-8444-555555555555' };
const good: CodexUpstreamState = { accounts: [{ ...goodAccount, accessToken: null, quotaSnapshot: null }] };

describe('assertCodexUpstreamState', () => {
  test('accepts active state', () => {
    expect(() => assertCodexUpstreamState(good)).not.toThrow();
  });
  test('accepts terminal states with state_message', () => {
    expect(() => assertCodexUpstreamState({
      accounts: [{
        chatgptAccountId: 'acc_x',
        refresh_token: 'rt_x',
        state: 'session_terminated',
        state_message: 'Token revoked',
        state_updated_at: '2026-06-05T00:00:00.000Z',
        openaiDeviceId: '11111111-2222-4333-8444-555555555555',
      }],
    })).not.toThrow();
    expect(() => assertCodexUpstreamState({
      accounts: [{ chatgptAccountId: 'acc_x', refresh_token: 'rt_x', state: 'refresh_failed', state_updated_at: '2026-06-05T00:00:00.000Z', openaiDeviceId: '11111111-2222-4333-8444-555555555555' }],
    })).not.toThrow();
  });
  test('rejects missing state_updated_at', () => {
    const { state_updated_at: _drop, ...withoutTimestamp } = goodAccount;
    expect(() => assertCodexUpstreamState({ accounts: [withoutTimestamp] })).toThrow(/state_updated_at/);
  });
  test('rejects empty refresh_token', () => {
    expect(() => assertCodexUpstreamState({ accounts: [{ ...goodAccount, refresh_token: '' }] })).toThrow(/refresh_token/);
  });
  test('rejects empty chatgptAccountId', () => {
    expect(() => assertCodexUpstreamState({ accounts: [{ ...goodAccount, chatgptAccountId: '' }] })).toThrow(/chatgptAccountId/);
  });
  test('rejects unknown state value', () => {
    expect(() => assertCodexUpstreamState({ accounts: [{ ...goodAccount, state: 'broken' }] })).toThrow(/state/);
  });
  test('rejects null / undefined / non-objects', () => {
    expect(() => assertCodexUpstreamState(null)).toThrow();
    expect(() => assertCodexUpstreamState(undefined)).toThrow();
    expect(() => assertCodexUpstreamState('s')).toThrow();
  });
  test('rejects unexpected keys at the top level', () => {
    expect(() => assertCodexUpstreamState({ ...good, extra_field: 'x' })).toThrow(/extra_field/);
  });
  test('rejects unexpected keys inside an account', () => {
    expect(() => assertCodexUpstreamState({ accounts: [{ ...goodAccount, smuggled: 'x' }] })).toThrow(/smuggled/);
  });
  // A key that also names an Object.prototype member is still an unknown key.
  // `__proto__` only survives as an own property through JSON.parse, so every
  // case is built that way for uniformity.
  test('rejects prototype-named keys at every guarded level', () => {
    const withKey = (target: object, key: string): unknown =>
      JSON.parse(`${JSON.stringify(target).slice(0, -1)},"${key}":1}`);
    for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      const account = { ...goodAccount, accessToken: null, quotaSnapshot: null };
      expect(() => assertCodexUpstreamState(withKey({ accounts: [account] }, key))).toThrow(new RegExp(key));
      expect(() => assertCodexUpstreamState({ accounts: [withKey(account, key)] })).toThrow(new RegExp(key));
      expect(() => assertCodexUpstreamState({
        accounts: [{ ...goodAccount, accessToken: withKey({ token: 't', expiresAt: 1, refreshedAt: 1 }, key) }],
      })).toThrow(new RegExp(key));
      expect(() => assertCodexUpstreamState({
        accounts: [{ ...goodAccount, quotaSnapshot: { primary: withKey({ fetchedAt: 1, data: {} }, key) } }],
      })).toThrow(new RegExp(key));
    }
  });
  test('rejects an empty accounts array (v1 invariant: exactly one)', () => {
    expect(() => assertCodexUpstreamState({ accounts: [] })).toThrow(/exactly one/);
  });
  test('rejects multiple accounts (v1 invariant: exactly one)', () => {
    expect(() => assertCodexUpstreamState({ accounts: [goodAccount, { ...goodAccount, chatgptAccountId: 'acc_y' }] })).toThrow(/exactly one/);
  });

  test('accepts accessToken absent / null / populated', () => {
    expect(() => assertCodexUpstreamState({ accounts: [{ ...goodAccount }] })).not.toThrow();
    expect(() => assertCodexUpstreamState({ accounts: [{ ...goodAccount, accessToken: null }] })).not.toThrow();
    expect(() => assertCodexUpstreamState({
      accounts: [{ ...goodAccount, accessToken: { token: 'at', expiresAt: 1_700_000_000_000, refreshedAt: '2026-06-05T00:00:00Z' } }],
    })).not.toThrow();
  });
  test('rejects malformed accessToken', () => {
    expect(() => assertCodexUpstreamState({
      accounts: [{ ...goodAccount, accessToken: { token: '', expiresAt: 1, refreshedAt: 'x' } }],
    })).toThrow(/token/);
    expect(() => assertCodexUpstreamState({
      accounts: [{ ...goodAccount, accessToken: { token: 'at', expiresAt: 'soon', refreshedAt: 'x' } }],
    })).toThrow(/expiresAt/);
    expect(() => assertCodexUpstreamState({
      accounts: [{ ...goodAccount, accessToken: { token: 'at', expiresAt: 1, refreshedAt: 'x', extra: 1 } }],
    })).toThrow(/extra/);
  });

  test('accepts quotaSnapshot absent / null / populated', () => {
    expect(() => assertCodexUpstreamState({ accounts: [{ ...goodAccount, quotaSnapshot: null }] })).not.toThrow();
    expect(() => assertCodexUpstreamState({
      accounts: [{
        ...goodAccount,
        quotaSnapshot: { premium: { fetchedAt: 1_700_000_000_000, data: { observed_at: '2026-06-05T00:00:00Z' } } },
      }],
    })).not.toThrow();
  });
  test('rejects malformed quotaSnapshot', () => {
    expect(() => assertCodexUpstreamState({
      accounts: [{ ...goodAccount, quotaSnapshot: { premium: { fetchedAt: 'soon', data: {} } } }],
    })).toThrow(/fetchedAt/);
    expect(() => assertCodexUpstreamState({
      accounts: [{ ...goodAccount, quotaSnapshot: { premium: { fetchedAt: 1, data: 'oops' } } }],
    })).toThrow(/data/);
    expect(() => assertCodexUpstreamState({
      accounts: [{ ...goodAccount, quotaSnapshot: { premium: { fetchedAt: 1, data: {}, extra: 1 } } }],
    })).toThrow(/extra/);
    expect(() => assertCodexUpstreamState({
      accounts: [{ ...goodAccount, quotaSnapshot: { premium: 123 } }],
    })).toThrow(/premium/);
    expect(() => assertCodexUpstreamState({
      accounts: [{ ...goodAccount, quotaSnapshot: { '': { fetchedAt: 1, data: {} } } }],
    })).toThrow(/invalid active limit key/);
    expect(() => assertCodexUpstreamState({
      accounts: [{ ...goodAccount, quotaSnapshot: { constructor: { fetchedAt: 1, data: {} } } }],
    })).toThrow(/invalid active limit key/);
  });

  test('rejects missing / empty openaiDeviceId', () => {
    const { openaiDeviceId: _drop, ...withoutDeviceId } = goodAccount;
    expect(() => assertCodexUpstreamState({ accounts: [withoutDeviceId] })).toThrow(/openaiDeviceId/);
    expect(() => assertCodexUpstreamState({ accounts: [{ ...goodAccount, openaiDeviceId: '' }] })).toThrow(/openaiDeviceId/);
    expect(() => assertCodexUpstreamState({ accounts: [{ ...goodAccount, openaiDeviceId: 42 }] })).toThrow(/openaiDeviceId/);
  });
});

describe('readCodexUpstreamState', () => {
  test('normalizes absent accessToken / quotaSnapshot to null', () => {
    const fresh = { chatgptAccountId: 'acc_x', refresh_token: 'rt_x', state: 'active' as const, state_updated_at: '2026-01-01T00:00:00Z', openaiDeviceId: '11111111-2222-4333-8444-555555555555' };
    const out = readCodexUpstreamState({ accounts: [fresh] });
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
    const out = readCodexUpstreamState(populated);
    expect(out.accounts[0].accessToken).toEqual(populated.accounts[0].accessToken);
    expect(out.accounts[0].quotaSnapshot).toEqual(populated.accounts[0].quotaSnapshot);
  });
});
