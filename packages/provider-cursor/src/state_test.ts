import { describe, expect, test } from 'vitest';

import { assertCursorUpstreamState, readCursorUpstreamState } from './state.ts';

const baseCred = {
  userId: 'u1',
  refresh_token: 'ref',
  state: 'active' as const,
  state_updated_at: '2026-01-01T00:00:00Z',
  accessToken: { token: 'tok', expiresAt: 9999999999999, refreshedAt: '2026-01-01T00:00:00Z' },
};

describe('assertCursorUpstreamState', () => {
  test('accepts a complete single-account state', () => {
    expect(() => assertCursorUpstreamState({ accounts: [baseCred] })).not.toThrow();
  });

  test('accepts a modelContext map of observed context windows', () => {
    expect(() => assertCursorUpstreamState({
      accounts: [baseCred],
      modelContext: { 'norm:claude-opus-4-8': { maxTokens: 200000, at: 123 }, 'max:claude-opus-4-8': { maxTokens: 1000000, at: 456 } },
    })).not.toThrow();
  });

  test.each([
    ['accounts not an array', { accounts: baseCred }],
    ['empty accounts', { accounts: [] }],
    ['two accounts', { accounts: [baseCred, { ...baseCred, userId: 'u2' }] }],
    ['extra top-level key', { accounts: [baseCred], extra: 1 }],
    ['missing userId', { accounts: [{ ...baseCred, userId: '' }] }],
    ['missing refresh_token', { accounts: [{ ...baseCred, refresh_token: '' }] }],
    ['bad state', { accounts: [{ ...baseCred, state: 'weird' }] }],
    ['missing state_updated_at', { accounts: [{ ...baseCred, state_updated_at: '' }] }],
    ['bad accessToken', { accounts: [{ ...baseCred, accessToken: { token: '', expiresAt: 1, refreshedAt: 'x' } }] }],
    ['modelContext entry missing maxTokens', { accounts: [baseCred], modelContext: { 'norm:m': { at: 1 } } }],
    ['modelContext entry with non-number at', { accounts: [baseCred], modelContext: { 'norm:m': { maxTokens: 1, at: 'x' } } }],
  ])('rejects %s', (_label, value) => {
    expect(() => assertCursorUpstreamState(value)).toThrow();
  });
});

describe('readCursorUpstreamState', () => {
  test('normalizes absent accessToken to null', () => {
    const legacy = {
      accounts: [
        {
          userId: 'u1',
          refresh_token: 'ref',
          state: 'active',
          state_updated_at: '2026-01-01T00:00:00Z',
        },
      ],
    };
    const read = readCursorUpstreamState(legacy);
    expect(read.accounts[0]!.accessToken).toBeNull();
    // original untouched
    expect((legacy.accounts[0] as Record<string, unknown>)['accessToken']).toBeUndefined();
  });
});
