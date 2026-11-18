import { describe, expect, test } from 'vitest';

import { assertClaudeCodeUpstreamState, type ClaudeCodeUpstreamState } from '../src/state.ts';

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
  test('rejects terminal state without stateMessage', () => {
    expect(() => assertClaudeCodeUpstreamState({
      accounts: [{ ...goodAccount, state: 'refresh_failed' }],
    })).toThrow(/stateMessage/);
    expect(() => assertClaudeCodeUpstreamState({
      accounts: [{ ...goodAccount, state: 'session_terminated', stateMessage: '' }],
    })).toThrow(/stateMessage/);
  });
  test('rejects setup-token with a non-null refreshToken', () => {
    expect(() => assertClaudeCodeUpstreamState({
      accounts: [{ ...goodSetupTokenAccount, refreshToken: 'leftover' }],
    })).toThrow(/refreshToken/);
  });
  test('rejects unexpected keys inside an account', () => {
    expect(() => assertClaudeCodeUpstreamState({ accounts: [{ ...goodAccount, smuggled: 'x' }] })).toThrow(/smuggled/);
  });
  test('rejects multiple accounts (v1 invariant: exactly one)', () => {
    expect(() => assertClaudeCodeUpstreamState({
      accounts: [goodAccount, { ...goodAccount, accountUuid: 'cccccccc-cccc-cccc-cccc-cccccccccccc' }],
    })).toThrow(/exactly one/);
  });
});
