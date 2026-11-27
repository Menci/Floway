import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  importClaudeCodeFromCallback,
  importClaudeCodeFromCredentialsJson,
  importClaudeCodeFromSetupTokenCallback,
} from '../../src/auth/import.ts';
import { jsonResponse } from '@floway-dev/test-utils';
import { directFetcher } from '@floway-dev/upstream';

const profileResponse = {
  account: {
    uuid: 'acc-uuid-1',
    email: 'user@example.com',
    has_claude_max: true,
    has_claude_pro: false,
    display_name: 'User',
  },
  organization: {
    uuid: 'org-uuid-1',
    organization_type: 'claude_max',
    rate_limit_tier: 'default_claude_max_20x',
    billing_type: 'subscription',
  },
};

const tokenResponse = {
  access_token: 'at',
  token_type: 'Bearer',
  expires_in: 3600,
  refresh_token: 'rt',
  scope: 'user:inference',
};

afterEach(() => vi.restoreAllMocks());

describe('importClaudeCodeFromCallback', () => {
  test('exchanges code, fetches profile, builds config + state', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(tokenResponse))
      .mockResolvedValueOnce(jsonResponse(profileResponse));

    const result = await importClaudeCodeFromCallback({ code: 'CODE', pkceVerifier: 'VER', state: 'STATE', fetcher: directFetcher });

    const profileInit = fetchSpy.mock.calls[1][1] as RequestInit;
    expect(new Headers(profileInit.headers).get('authorization')).toBe('Bearer at');

    expect(result.config.accounts).toEqual([{
      email: 'user@example.com',
      accountUuid: 'acc-uuid-1',
      organizationUuid: 'org-uuid-1',
      subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x',
    }]);
    expect(result.state.accounts[0].accountUuid).toBe('acc-uuid-1');
    expect(result.state.accounts[0].tokenKind).toBe('oauth');
    expect(result.state.accounts[0].refreshToken).toBe('rt');
    expect(result.state.accounts[0].state).toBe('active');
    expect(result.state.accounts[0].accessToken?.token).toBe('at');
    expect(result.state.accounts[0].accessToken?.expiresAt).toBeGreaterThan(Date.now());
  });

});

describe('importClaudeCodeFromCredentialsJson', () => {
  const farFutureMs = Date.now() + 30 * 60 * 1000;

  test('happy path uses CLI subscriptionType verbatim and reuses the access token', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse(profileResponse));
    const raw = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-x',
        refreshToken: 'sk-ant-ort01-y',
        expiresAt: farFutureMs,
        scopes: ['org:create_api_key', 'user:profile'],
        subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x',
      },
    });

    const result = await importClaudeCodeFromCredentialsJson(raw);

    expect(result.config.accounts[0].subscriptionType).toBe('max');
    expect(result.config.accounts[0].rateLimitTier).toBe('default_claude_max_20x');
    expect(result.config.accounts[0].email).toBe('user@example.com');
    expect(result.state.accounts[0].refreshToken).toBe('sk-ant-ort01-y');
    expect(result.state.accounts[0].accessToken?.token).toBe('sk-ant-oat01-x');
    expect(result.state.accounts[0].accessToken?.expiresAt).toBe(farFutureMs);
  });

  test('rejects when expiresAt looks like seconds rather than milliseconds', async () => {
    const raw = JSON.stringify({
      claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: 1781234567 },
    });
    await expect(importClaudeCodeFromCredentialsJson(raw)).rejects.toThrow();
  });
});

describe('importClaudeCodeFromSetupTokenCallback', () => {
  // Anthropic's setup-token exchange returns a long-lived access token with no
  // refresh_token. The bearer also lacks `user:profile` so the identity fetch
  // 403s and falls back to the degraded shape (deterministic accountUuid +
  // nulls for personal fields).
  const setupTokenResponse = {
    access_token: 'st_long_lived',
    token_type: 'Bearer',
    expires_in: 31536000,
    scope: 'user:inference',
  };
  const permissionError403 = {
    error: { type: 'permission_error', message: 'token lacks user:profile scope' },
  };

  test('exchanges with expires_in=31536000, falls back to degraded identity, persists tokenKind=setup-token', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(setupTokenResponse))
      .mockResolvedValueOnce(jsonResponse(permissionError403, 403));

    const result = await importClaudeCodeFromSetupTokenCallback({ code: 'CODE', pkceVerifier: 'VER', state: 'STATE', fetcher: directFetcher });

    const exchangeBody = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(exchangeBody.expires_in).toBe(31536000);

    // Degraded identity: deterministic UUID + nulls.
    expect(result.config.accounts[0].email).toBeNull();
    expect(result.config.accounts[0].organizationUuid).toBeNull();
    expect(result.config.accounts[0].subscriptionType).toBeNull();
    expect(result.config.accounts[0].accountUuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    // State carries the new kind marker, no refresh token, and the long-lived
    // access token as the cached credential.
    expect(result.state.accounts[0].tokenKind).toBe('setup-token');
    expect(result.state.accounts[0].refreshToken).toBeNull();
    expect(result.state.accounts[0].accessToken?.token).toBe('st_long_lived');
    expect(result.state.accounts[0].accessToken?.expiresAt).toBeGreaterThan(Date.now() + 360 * 24 * 60 * 60 * 1000);
  });
});
