import { describe, expect, test } from 'vitest';

import { deriveCursorIdentity, buildCursorImportConfig, buildCursorImportState } from './import.ts';

const jwt = (payload: object): string => `header.${btoa(JSON.stringify(payload))}.sig`;

describe('deriveCursorIdentity', () => {
  test('reads sub + email from the JWT', () => {
    const id = deriveCursorIdentity(jwt({ sub: 'u1', email: 'a@b.com' }));
    expect(id.userId).toBe('u1');
    expect(id.email).toBe('a@b.com');
  });

  test('falls back to name when email is absent', () => {
    const id = deriveCursorIdentity(jwt({ sub: 'u1', name: 'Alice' }));
    expect(id.email).toBe('Alice');
  });

  test('placeholders for a non-JWT token', () => {
    const id = deriveCursorIdentity('not-a-jwt');
    expect(id.userId).toBe('cursor-user');
    expect(id.email).toBe('cursor-user');
  });
});

describe('buildCursorImportConfig', () => {
  test('wraps an identity in a 1-tuple', () => {
    const cfg = buildCursorImportConfig({ email: 'a@b', userId: 'u1' });
    expect(cfg.accounts).toHaveLength(1);
    expect(cfg.accounts[0]!.userId).toBe('u1');
  });
});

describe('buildCursorImportState', () => {
  test('builds an active credential with a cached access token', () => {
    const tokens = { accessToken: jwt({ sub: 'u1', email: 'a@b' }), refreshToken: 'ref' };
    const state = buildCursorImportState(tokens);
    expect(state.accounts).toHaveLength(1);
    const acc = state.accounts[0]!;
    expect(acc.userId).toBe('u1');
    expect(acc.refresh_token).toBe('ref');
    expect(acc.state).toBe('active');
    expect(acc.state_updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(acc.accessToken!.token).toBe(tokens.accessToken);
    expect(acc.accessToken!.expiresAt).toBeGreaterThan(Date.now());
  });
});
