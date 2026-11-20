import { afterEach, describe, expect, test, vi } from 'vitest';

import { ClaudeCodeOAuthSessionTerminatedError, exchangeClaudeCodeAuthorizationCode } from '../../src/auth/oauth.ts';
import { directFetcher } from '@floway-dev/provider';

const errorResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.restoreAllMocks());

describe('exchangeClaudeCodeAuthorizationCode', () => {
  test('invalid_grant on exchange is NOT terminal (recoverable stale-paste; PKCE restart)', async () => {
    // Per RFC 6749, `invalid_grant` on the authorization_code grant means the
    // code is expired / wrong / replayed. There is no session yet to
    // "terminate" — the operator just restarts PKCE. Mirrors codex's split.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      errorResponse(400, { error: 'invalid_grant', error_description: 'Authorization code expired' }),
    );
    const promise = exchangeClaudeCodeAuthorizationCode({ code: 'CODE', codeVerifier: 'VER', state: 'STATE', kind: 'oauth', fetcher: directFetcher });
    await expect(promise).rejects.not.toBeInstanceOf(ClaudeCodeOAuthSessionTerminatedError);
  });
});
