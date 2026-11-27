import { afterEach, describe, expect, test, vi } from 'vitest';

import { ChatGPTOAuthSessionTerminatedError, refreshChatGPTAccessToken } from '../../src/auth/oauth.ts';
import { directFetcher } from '@floway-dev/upstream';

const errorResponse = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.restoreAllMocks());

describe('refreshChatGPTAccessToken', () => {
  test('invalid_grant → ChatGPTOAuthSessionTerminatedError (refresh-only)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(errorResponse(400, { error: { code: 'invalid_grant', message: 'Your refresh token has already been used to generate a new access token. Please try signing in again.' } }));
    await expect(refreshChatGPTAccessToken('rt_replayed', directFetcher)).rejects.toBeInstanceOf(ChatGPTOAuthSessionTerminatedError);
  });
});
