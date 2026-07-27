import { afterEach, describe, expect, test, vi } from 'vitest';

import { buildCodexAuthorizeUrl, CodexOAuthSessionTerminatedError, exchangeCodexAuthorizationCode, refreshCodexAccessToken } from '../../src/auth/oauth.ts';
import { directFetcher } from '@floway-dev/provider';

const okResponse = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const errorResponse = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.restoreAllMocks());

test('buildCodexAuthorizeUrl preserves the Codex CLI query surface and order', () => {
  expect(buildCodexAuthorizeUrl({ state: 'STATE', codeChallenge: 'CHALLENGE' })).toBe(
    'https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_EMoamEEZ73f0CkXaXp7hrann&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&scope=openid+profile+email+offline_access&state=STATE&code_challenge=CHALLENGE&code_challenge_method=S256&id_token_add_organizations=true&codex_cli_simplified_flow=true&originator=codex_cli_rs',
  );
});

describe('exchangeCodexAuthorizationCode', () => {
  test('POSTs form data and returns parsed tokens', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse({
      access_token: 'at', refresh_token: 'rt', id_token: 'it', expires_in: 600,
    }));
    const result = await exchangeCodexAuthorizationCode({ code: 'CODE', codeVerifier: 'VER', fetcher: directFetcher });
    expect(result).toEqual({ access_token: 'at', refresh_token: 'rt', id_token: 'it', expires_in: 600 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://auth.openai.com/oauth/token');
    expect((init as RequestInit).method).toBe('POST');
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.get('content-type')).toMatch(/application\/x-www-form-urlencoded/);
    expect(headers.get('user-agent')).toBe('codex-cli/0.91.0');
    const body = (init as RequestInit).body as string;
    const params = new URLSearchParams(body);
    expect(params.get('grant_type')).toBe('authorization_code');
    expect(params.get('code')).toBe('CODE');
    expect(params.get('code_verifier')).toBe('VER');
    expect(params.get('client_id')).toBe('app_EMoamEEZ73f0CkXaXp7hrann');
    expect(params.get('redirect_uri')).toBe('http://localhost:1455/auth/callback');
  });

  test('throws session-terminated on app_session_terminated', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(errorResponse(400, { error: { code: 'app_session_terminated', message: 'Session ended' } }));
    await expect(exchangeCodexAuthorizationCode({ code: 'CODE', codeVerifier: 'VER', fetcher: directFetcher })).rejects.toBeInstanceOf(CodexOAuthSessionTerminatedError);
  });

  test('throws generic error on other 4xx, message includes status', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(errorResponse(400, { error: { code: 'invalid_grant', message: 'bad code' } }));
    await expect(exchangeCodexAuthorizationCode({ code: 'CODE', codeVerifier: 'VER', fetcher: directFetcher })).rejects.toThrow(/400/);
  });
});

describe('refreshCodexAccessToken', () => {
  test('POSTs grant_type=refresh_token + scope', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse({ access_token: 'at2', refresh_token: 'rt2', id_token: 'it2', expires_in: 600 }));
    const result = await refreshCodexAccessToken('rt_old', directFetcher);
    expect(result.access_token).toBe('at2');
    expect(result.refresh_token).toBe('rt2');
    const params = new URLSearchParams((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(params.get('grant_type')).toBe('refresh_token');
    expect(params.get('refresh_token')).toBe('rt_old');
    expect(params.get('client_id')).toBe('app_EMoamEEZ73f0CkXaXp7hrann');
    expect(params.get('scope')).toBe('openid profile email offline_access');
  });

  test('session-terminated → CodexOAuthSessionTerminatedError', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(errorResponse(400, { error: { code: 'app_session_terminated', message: 'gone' } }));
    await expect(refreshCodexAccessToken('rt_dead', directFetcher)).rejects.toBeInstanceOf(CodexOAuthSessionTerminatedError);
  });

  test('invalid_grant → CodexOAuthSessionTerminatedError (refresh-only)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(errorResponse(400, { error: { code: 'invalid_grant', message: 'Your refresh token has already been used to generate a new access token. Please try signing in again.' } }));
    await expect(refreshCodexAccessToken('rt_replayed', directFetcher)).rejects.toBeInstanceOf(CodexOAuthSessionTerminatedError);
  });
});
