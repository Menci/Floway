import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  importClaudeCodeFromCallback,
  importClaudeCodeFromCredentialsJson,
  importClaudeCodeFromSetupTokenCallback,
} from '../../src/auth/import.ts';
import { directFetcher, type Fetcher } from '@floway-dev/provider';
import { jsonResponse } from '@floway-dev/test-utils';

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

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0][0]).toBe('https://platform.claude.com/v1/oauth/token');
    expect(fetchSpy.mock.calls[1][0]).toBe('https://api.anthropic.com/api/oauth/profile');
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

  test('personal account (no organization block) yields null subscriptionType', async () => {
    // Mirrors what Anthropic's profile endpoint returns for free/pro personal
    // accounts: the `organization` object is omitted entirely. The official
    // CLI's deriver A10 returns null in this case (cli.js v2.1.10); we follow.
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(tokenResponse))
      .mockResolvedValueOnce(jsonResponse({
        account: { uuid: 'acc-uuid-personal', email: 'me@example.com', has_claude_pro: true },
      }));

    const result = await importClaudeCodeFromCallback({ code: 'CODE', pkceVerifier: 'VER', state: 'STATE', fetcher: directFetcher });

    expect(result.config.accounts).toEqual([{
      email: 'me@example.com',
      accountUuid: 'acc-uuid-personal',
      organizationUuid: null,
      subscriptionType: null,
      rateLimitTier: null,
    }]);
  });

  test('unknown organization_type yields null subscriptionType (rateLimitTier still captured)', async () => {
    // Forward-compat: a new Anthropic tier (e.g. "personal", "individual") must
    // not break ingest. organization_type maps to null; rate_limit_tier flows
    // through verbatim since it is not enum-cast.
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(tokenResponse))
      .mockResolvedValueOnce(jsonResponse({
        account: { uuid: 'acc-uuid-future', email: 'future@example.com' },
        organization: { uuid: 'org-uuid-future', organization_type: 'claude_personal', rate_limit_tier: 'default_claude_personal' },
      }));

    const result = await importClaudeCodeFromCallback({ code: 'CODE', pkceVerifier: 'VER', state: 'STATE', fetcher: directFetcher });
    expect(result.config.accounts[0].subscriptionType).toBeNull();
    expect(result.config.accounts[0].rateLimitTier).toBe('default_claude_personal');
    expect(result.config.accounts[0].organizationUuid).toBe('org-uuid-future');
  });

  test('claude_max with unknown rate_limit_tier passes through verbatim (no longer throws)', async () => {
    // Previously we threw on unknown rate_limit_tier under claude_max, but
    // now that subscriptionType ('max') and rateLimitTier (raw string) live
    // in separate fields, a new Anthropic tier (e.g. "default_claude_max_99x"
    // for a hypothetical future plan) flows through without breaking ingest.
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(tokenResponse))
      .mockResolvedValueOnce(jsonResponse({
        account: { uuid: 'acc-uuid-2', email: 'max@example.com' },
        organization: { uuid: 'org-uuid-2', organization_type: 'claude_max', rate_limit_tier: 'default_claude_max_99x' },
      }));

    const result = await importClaudeCodeFromCallback({ code: 'CODE', pkceVerifier: 'VER', state: 'STATE', fetcher: directFetcher });
    expect(result.config.accounts[0].subscriptionType).toBe('max');
    expect(result.config.accounts[0].rateLimitTier).toBe('default_claude_max_99x');
  });
});

describe('importClaudeCodeFromCredentialsJson', () => {
  const farFutureMs = Date.now() + 30 * 60 * 1000;

  test('happy path uses CLI subscriptionType verbatim and reuses the access token', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse(profileResponse));
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

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe('https://api.anthropic.com/api/oauth/profile');
    expect(result.config.accounts[0].subscriptionType).toBe('max');
    expect(result.config.accounts[0].rateLimitTier).toBe('default_claude_max_20x');
    expect(result.config.accounts[0].email).toBe('user@example.com');
    expect(result.state.accounts[0].refreshToken).toBe('sk-ant-ort01-y');
    expect(result.state.accounts[0].accessToken?.token).toBe('sk-ant-oat01-x');
    expect(result.state.accounts[0].accessToken?.expiresAt).toBe(farFutureMs);
  });

  test('falls back to derived subscriptionType when CLI fields are absent', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({
      ...profileResponse,
      organization: { ...profileResponse.organization, rate_limit_tier: 'default_claude_max_5x' },
    }));
    const raw = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'a', refreshToken: 'r', expiresAt: farFutureMs,
      },
    });
    const result = await importClaudeCodeFromCredentialsJson(raw);
    expect(result.config.accounts[0].subscriptionType).toBe('max');
    expect(result.config.accounts[0].rateLimitTier).toBe('default_claude_max_5x');
  });

  test('personal account with neither persisted nor derived subscriptionType yields null', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({
      account: { uuid: 'acc-uuid-personal', email: 'me@example.com' },
    }));
    const raw = JSON.stringify({
      claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: farFutureMs },
    });
    const result = await importClaudeCodeFromCredentialsJson(raw);
    expect(result.config.accounts[0].subscriptionType).toBeNull();
    expect(result.config.accounts[0].organizationUuid).toBeNull();
  });

  test('persisted subscriptionType + rateLimitTier win even when derived is null', async () => {
    // Operator's credentials.json carried `subscriptionType: 'max'` plus
    // `rateLimitTier: 'default_claude_max_20x'` from the CLI, but the live
    // /api/oauth/profile shows no organization block. Persisted non-null
    // should win — the JSON is the authoritative snapshot.
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({
      account: { uuid: 'acc-uuid-personal', email: 'me@example.com' },
    }));
    const raw = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'a', refreshToken: 'r', expiresAt: farFutureMs,
        subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x',
      },
    });
    const result = await importClaudeCodeFromCredentialsJson(raw);
    expect(result.config.accounts[0].subscriptionType).toBe('max');
    expect(result.config.accounts[0].rateLimitTier).toBe('default_claude_max_20x');
  });

  test('credentials.json import with a 403-permission_error token yields a degraded identity', async () => {
    // Token minted without `user:profile` scope: profile endpoint 403s, the
    // identity fallback returns a deterministic accountUuid + nulls for
    // email/org/subscriptionType. credentials.json may still carry the CLI
    // `subscriptionType` field — when present, that wins over the degraded
    // null per the buildClaudeCodeImportResult contract (CLI-persisted
    // subscriptionType is authoritative).
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({
      error: { type: 'permission_error', message: 'token lacks user:profile scope' },
    }, 403));
    const raw = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'at_no_scope', refreshToken: 'r', expiresAt: farFutureMs,
        subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x',
      },
    });
    const result = await importClaudeCodeFromCredentialsJson(raw);
    expect(result.config.accounts[0].email).toBeNull();
    expect(result.config.accounts[0].organizationUuid).toBeNull();
    expect(result.config.accounts[0].subscriptionType).toBe('max');
    expect(result.config.accounts[0].rateLimitTier).toBe('default_claude_max_5x');
    expect(result.config.accounts[0].accountUuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(result.state.accounts[0].accessToken?.token).toBe('at_no_scope');
  });

  test('rejects when JSON is malformed', async () => {
    await expect(importClaudeCodeFromCredentialsJson('{ not json')).rejects.toThrow();
  });

  test('rejects when claudeAiOauth wrapper is missing', async () => {
    await expect(importClaudeCodeFromCredentialsJson(JSON.stringify({}))).rejects.toThrow(/claudeAiOauth/);
  });

  test('rejects when accessToken is missing', async () => {
    const raw = JSON.stringify({ claudeAiOauth: { refreshToken: 'r', expiresAt: farFutureMs } });
    await expect(importClaudeCodeFromCredentialsJson(raw)).rejects.toThrow(/accessToken/);
  });

  test('rejects when expiresAt looks like seconds rather than milliseconds', async () => {
    const raw = JSON.stringify({
      claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: 1781234567 },
    });
    await expect(importClaudeCodeFromCredentialsJson(raw)).rejects.toThrow(/milliseconds/);
  });

  test('surfaces profile API failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({ error: 'unauthorized' }, 401));
    const raw = JSON.stringify({
      claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: farFutureMs },
    });
    await expect(importClaudeCodeFromCredentialsJson(raw)).rejects.toThrow(/401/);
  });

  test('routes the identity fetch through the supplied fetcher', async () => {
    const fetcher = vi.fn<Fetcher>(async () => jsonResponse(profileResponse));
    // globalThis.fetch is left unmocked — a leak through to it would throw a
    // real network error in the test runner, so a green run confirms the
    // override is the only egress.
    const raw = JSON.stringify({
      claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: farFutureMs },
    });
    await importClaudeCodeFromCredentialsJson(raw, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe('https://api.anthropic.com/api/oauth/profile');
  });
});

describe('importClaudeCodeFromCallback fetcher override', () => {
  test('routes both the token exchange and the identity fetch through the supplied fetcher', async () => {
    const fetcher = vi.fn<Fetcher>()
      .mockResolvedValueOnce(jsonResponse(tokenResponse))
      .mockResolvedValueOnce(jsonResponse(profileResponse));
    await importClaudeCodeFromCallback({ code: 'CODE', pkceVerifier: 'VER', state: 'STATE', fetcher });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0][0]).toBe('https://platform.claude.com/v1/oauth/token');
    expect(fetcher.mock.calls[1][0]).toBe('https://api.anthropic.com/api/oauth/profile');
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

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0][0]).toBe('https://platform.claude.com/v1/oauth/token');
    const exchangeBody = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(exchangeBody.expires_in).toBe(31536000);
    expect(fetchSpy.mock.calls[1][0]).toBe('https://api.anthropic.com/api/oauth/profile');

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

  test('routes both fetches through the supplied fetcher', async () => {
    const fetcher = vi.fn<Fetcher>()
      .mockResolvedValueOnce(jsonResponse(setupTokenResponse))
      .mockResolvedValueOnce(jsonResponse(permissionError403, 403));
    await importClaudeCodeFromSetupTokenCallback({ code: 'CODE', pkceVerifier: 'VER', state: 'STATE', fetcher });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0][0]).toBe('https://platform.claude.com/v1/oauth/token');
    expect(fetcher.mock.calls[1][0]).toBe('https://api.anthropic.com/api/oauth/profile');
  });

  test('still derives a real identity when the setup-token bearer happens to satisfy user:profile (forward-compat)', async () => {
    // Anthropic could in principle widen the setup-token scope set in a
    // future release; if the profile endpoint returns a real account, we
    // honor it just like the full OAuth path does. The kind marker stays
    // `setup-token` regardless because the credential class is what matters
    // for the refresh decision, not the identity richness.
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(setupTokenResponse))
      .mockResolvedValueOnce(jsonResponse(profileResponse));
    const result = await importClaudeCodeFromSetupTokenCallback({ code: 'CODE', pkceVerifier: 'VER', state: 'STATE', fetcher: directFetcher });
    expect(result.config.accounts[0].email).toBe('user@example.com');
    expect(result.config.accounts[0].accountUuid).toBe('acc-uuid-1');
    expect(result.state.accounts[0].tokenKind).toBe('setup-token');
    expect(result.state.accounts[0].refreshToken).toBeNull();
  });
});
