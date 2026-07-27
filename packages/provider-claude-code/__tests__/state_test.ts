import { describe, expect, test } from 'vitest';

import type { ClaudeCodeQuotaSnapshot } from '../src/quota.ts';
import { assertClaudeCodeUpstreamState, readClaudeCodeUpstreamState, type ClaudeCodeUpstreamState } from '../src/state.ts';

const fullQuotaSnapshot: ClaudeCodeQuotaSnapshot = {
  status: 'allowed',
  reset: null,
  fallbackAvailable: null,
  fallbackPercentage: null,
  representativeClaim: null,
  overage: null,
  fiveHour: null,
  sevenDay: null,
  raw: {},
};

const goodAccount = {
  accountUuid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  tokenKind: 'oauth' as const,
  refreshToken: 'sk-ant-ort01-rt',
  state: 'active' as const,
  stateUpdatedAt: '2026-06-19T00:00:00Z',
  accessToken: null,
  quotaSnapshot: null,
  usageProbeSnapshot: null,
};
const good: ClaudeCodeUpstreamState = {
  accounts: [{ ...goodAccount }],
};

const goodSetupTokenAccount = {
  accountUuid: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  tokenKind: 'setup-token' as const,
  refreshToken: null,
  state: 'active' as const,
  stateUpdatedAt: '2026-06-19T00:00:00Z',
  accessToken: { token: 'st_long_lived', expiresAt: 1_700_000_000_000, refreshedAt: '2026-06-19T00:00:00Z' },
  quotaSnapshot: null,
  usageProbeSnapshot: null,
};

describe('assertClaudeCodeUpstreamState', () => {
  test('accepts active state', () => {
    expect(() => assertClaudeCodeUpstreamState(good)).not.toThrow();
  });
  test('accepts terminal states with stateMessage', () => {
    expect(() => assertClaudeCodeUpstreamState({
      accounts: [{
        ...goodAccount,
        state: 'session_terminated',
        stateMessage: 'Token revoked',
      }],
    })).not.toThrow();
    expect(() => assertClaudeCodeUpstreamState({
      accounts: [{ ...goodAccount, state: 'refresh_failed', stateMessage: 'Refresh failed' }],
    })).not.toThrow();
  });
  test('rejects terminal state without stateMessage', () => {
    expect(() => assertClaudeCodeUpstreamState({
      accounts: [{ ...goodAccount, state: 'refresh_failed' }],
    })).toThrow(/stateMessage/);
    expect(() => assertClaudeCodeUpstreamState({
      accounts: [{ ...goodAccount, state: 'session_terminated', stateMessage: '' }],
    })).toThrow(/stateMessage/);
  });
  test('rejects stateMessage on active state', () => {
    expect(() => assertClaudeCodeUpstreamState({
      accounts: [{ ...goodAccount, stateMessage: 'shouldnt be here' }],
    })).toThrow(/stateMessage/);
  });
  test('rejects missing stateUpdatedAt', () => {
    const { stateUpdatedAt: _drop, ...withoutTimestamp } = goodAccount;
    expect(() => assertClaudeCodeUpstreamState({ accounts: [withoutTimestamp] })).toThrow(/stateUpdatedAt/);
  });
  test('rejects empty refreshToken on oauth', () => {
    expect(() => assertClaudeCodeUpstreamState({ accounts: [{ ...goodAccount, refreshToken: '' }] })).toThrow(/refreshToken/);
  });
  test('accepts setup-token with null refreshToken + populated accessToken', () => {
    expect(() => assertClaudeCodeUpstreamState({ accounts: [{ ...goodSetupTokenAccount }] })).not.toThrow();
  });
  test('rejects setup-token with a non-null refreshToken', () => {
    expect(() => assertClaudeCodeUpstreamState({
      accounts: [{ ...goodSetupTokenAccount, refreshToken: 'leftover' }],
    })).toThrow(/refreshToken/);
  });
  test('rejects oauth with null refreshToken', () => {
    expect(() => assertClaudeCodeUpstreamState({
      accounts: [{ ...goodAccount, refreshToken: null }],
    })).toThrow(/refreshToken/);
  });
  test('rejects unknown or missing tokenKind', () => {
    expect(() => assertClaudeCodeUpstreamState({
      accounts: [{ ...goodAccount, tokenKind: 'apikey' }],
    })).toThrow(/tokenKind/);
    const { tokenKind: _drop, ...withoutKind } = goodAccount;
    expect(() => assertClaudeCodeUpstreamState({ accounts: [withoutKind] })).toThrow(/tokenKind/);
  });
  test('rejects empty accountUuid', () => {
    expect(() => assertClaudeCodeUpstreamState({ accounts: [{ ...goodAccount, accountUuid: '' }] })).toThrow(/accountUuid/);
  });
  test('rejects unknown state value', () => {
    expect(() => assertClaudeCodeUpstreamState({ accounts: [{ ...goodAccount, state: 'broken' }] })).toThrow(/state/);
  });
  test('rejects null / undefined / non-objects', () => {
    expect(() => assertClaudeCodeUpstreamState(null)).toThrow();
    expect(() => assertClaudeCodeUpstreamState(undefined)).toThrow();
    expect(() => assertClaudeCodeUpstreamState('s')).toThrow();
  });
  test('rejects unexpected keys at the top level', () => {
    expect(() => assertClaudeCodeUpstreamState({ ...good, extraField: 'x' })).toThrow(/extraField/);
  });
  test('rejects unexpected keys inside an account', () => {
    expect(() => assertClaudeCodeUpstreamState({ accounts: [{ ...goodAccount, smuggled: 'x' }] })).toThrow(/smuggled/);
  });
  test('rejects an empty accounts array (v1 invariant: exactly one)', () => {
    expect(() => assertClaudeCodeUpstreamState({ accounts: [] })).toThrow(/exactly one/);
  });
  test('rejects multiple accounts (v1 invariant: exactly one)', () => {
    expect(() => assertClaudeCodeUpstreamState({
      accounts: [goodAccount, { ...goodAccount, accountUuid: 'cccccccc-cccc-cccc-cccc-cccccccccccc' }],
    })).toThrow(/exactly one/);
  });

  test('accepts accessToken null / populated', () => {
    expect(() => assertClaudeCodeUpstreamState({ accounts: [{ ...goodAccount, accessToken: null }] })).not.toThrow();
    expect(() => assertClaudeCodeUpstreamState({
      accounts: [{
        ...goodAccount,
        accessToken: { token: 'at', expiresAt: 1_700_000_000_000, refreshedAt: '2026-06-19T00:00:00Z' },
      }],
    })).not.toThrow();
  });
  test('rejects absent accessToken (must be explicit null on the wire)', () => {
    const { accessToken: _drop, ...withoutAccess } = goodAccount;
    expect(() => assertClaudeCodeUpstreamState({ accounts: [withoutAccess] })).toThrow(/accessToken/);
  });
  test('rejects malformed accessToken', () => {
    expect(() => assertClaudeCodeUpstreamState({
      accounts: [{ ...goodAccount, accessToken: { token: '', expiresAt: 1, refreshedAt: 'x' } }],
    })).toThrow(/token/);
    expect(() => assertClaudeCodeUpstreamState({
      accounts: [{ ...goodAccount, accessToken: { token: 'at', expiresAt: 'soon', refreshedAt: 'x' } }],
    })).toThrow(/expiresAt/);
    expect(() => assertClaudeCodeUpstreamState({
      accounts: [{ ...goodAccount, accessToken: { token: 'at', expiresAt: 1, refreshedAt: 'x', extra: 1 } }],
    })).toThrow(/extra/);
  });

  test('accepts quotaSnapshot null / populated', () => {
    expect(() => assertClaudeCodeUpstreamState({ accounts: [{ ...goodAccount, quotaSnapshot: null }] })).not.toThrow();
    expect(() => assertClaudeCodeUpstreamState({
      accounts: [{
        ...goodAccount,
        quotaSnapshot: { fetchedAt: 1_700_000_000_000, data: fullQuotaSnapshot },
      }],
    })).not.toThrow();
  });
  test('rejects malformed quotaSnapshot wrapper', () => {
    expect(() => assertClaudeCodeUpstreamState({
      accounts: [{ ...goodAccount, quotaSnapshot: { fetchedAt: 'soon', data: fullQuotaSnapshot } }],
    })).toThrow(/fetchedAt/);
    expect(() => assertClaudeCodeUpstreamState({
      accounts: [{ ...goodAccount, quotaSnapshot: { fetchedAt: 1, data: 'oops' } }],
    })).toThrow(/data/);
    expect(() => assertClaudeCodeUpstreamState({
      accounts: [{ ...goodAccount, quotaSnapshot: { fetchedAt: 1, data: fullQuotaSnapshot, extra: 1 } }],
    })).toThrow(/extra/);
  });
  test('rejects quotaSnapshot.data missing required fields', () => {
    expect(() => assertClaudeCodeUpstreamState({
      accounts: [{ ...goodAccount, quotaSnapshot: { fetchedAt: 1, data: { status: 'allowed' } } }],
    })).toThrow(/data\.reset/);
  });

  test('accepts usageProbeSnapshot null / populated', () => {
    expect(() => assertClaudeCodeUpstreamState({ accounts: [{ ...goodAccount, usageProbeSnapshot: null }] })).not.toThrow();
    expect(() => assertClaudeCodeUpstreamState({
      accounts: [{
        ...goodAccount,
        usageProbeSnapshot: { fetchedAt: 1_700_000_000_000, data: { five_hour: { utilization: 0.5 }, anything: 'goes' } },
      }],
    })).not.toThrow();
  });
  test('rejects absent usageProbeSnapshot (must be explicit null on the wire)', () => {
    const { usageProbeSnapshot: _drop, ...without } = goodAccount;
    expect(() => assertClaudeCodeUpstreamState({ accounts: [without] })).toThrow(/usageProbeSnapshot/);
  });
  test('rejects malformed usageProbeSnapshot wrapper', () => {
    expect(() => assertClaudeCodeUpstreamState({
      accounts: [{ ...goodAccount, usageProbeSnapshot: { fetchedAt: 'soon', data: {} } }],
    })).toThrow(/fetchedAt/);
    expect(() => assertClaudeCodeUpstreamState({
      accounts: [{ ...goodAccount, usageProbeSnapshot: { fetchedAt: 1, data: 'oops' } }],
    })).toThrow(/data/);
    expect(() => assertClaudeCodeUpstreamState({
      accounts: [{ ...goodAccount, usageProbeSnapshot: { fetchedAt: 1, data: {}, extra: 1 } }],
    })).toThrow(/extra/);
  });
});

describe('readClaudeCodeUpstreamState', () => {
  test('preserves populated entries verbatim', () => {
    const populated = {
      accounts: [{
        ...goodAccount,
        accessToken: { token: 'at', expiresAt: 1_700_000_000_000, refreshedAt: '2026-06-19T00:00:00Z' },
        quotaSnapshot: { fetchedAt: 1_700_000_000_000, data: fullQuotaSnapshot },
      }],
    };
    const out = readClaudeCodeUpstreamState(populated);
    expect(out.accounts[0].accessToken).toEqual(populated.accounts[0].accessToken);
    expect(out.accounts[0].quotaSnapshot).toEqual(populated.accounts[0].quotaSnapshot);
  });

  test('preserves explicit setup-token kind', () => {
    const out = readClaudeCodeUpstreamState({ accounts: [{ ...goodSetupTokenAccount }] });
    expect(out.accounts[0].tokenKind).toBe('setup-token');
    expect(out.accounts[0].refreshToken).toBeNull();
  });
});
