import { describe, expect, test } from 'vitest';

import { refreshCursorAccessToken, CursorSessionTerminatedError, getTokenExpiry } from './oauth.ts';
import type { Fetcher } from '@floway-dev/provider';

const mkFetcher = (fn: (url: string) => Response | Promise<Response>): Fetcher => fn as unknown as Fetcher;

const jsonRes = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('refreshCursorAccessToken', () => {
  test('returns tokens on 200', async () => {
    const fetcher = mkFetcher(async () => jsonRes({ accessToken: 'acc', refreshToken: 'ref' }));
    const tokens = await refreshCursorAccessToken('old-ref', fetcher);
    expect(tokens.access_token).toBe('acc');
    expect(tokens.refresh_token).toBe('ref');
    expect(tokens.expires_at).toBeGreaterThan(Date.now());
  });

  test('preserves the old refresh token when the response omits it', async () => {
    const fetcher = mkFetcher(async () => jsonRes({ accessToken: 'acc' }));
    const tokens = await refreshCursorAccessToken('old-ref', fetcher);
    expect(tokens.refresh_token).toBe('old-ref');
  });

  test('throws CursorSessionTerminatedError on 401', async () => {
    const fetcher = mkFetcher(async () => new Response('unauthorized', { status: 401 }));
    await expect(refreshCursorAccessToken('ref', fetcher)).rejects.toBeInstanceOf(CursorSessionTerminatedError);
  });

  test('throws CursorSessionTerminatedError on 403', async () => {
    const fetcher = mkFetcher(async () => new Response('forbidden', { status: 403 }));
    await expect(refreshCursorAccessToken('ref', fetcher)).rejects.toBeInstanceOf(CursorSessionTerminatedError);
  });

  test('throws a plain Error (not terminal) on 500', async () => {
    const fetcher = mkFetcher(async () => new Response('boom', { status: 500 }));
    await expect(refreshCursorAccessToken('ref', fetcher)).rejects.not.toBeInstanceOf(CursorSessionTerminatedError);
  });

  test('rejects a 200 missing accessToken', async () => {
    const fetcher = mkFetcher(async () => jsonRes({ refreshToken: 'r' }));
    await expect(refreshCursorAccessToken('ref', fetcher)).rejects.toThrow('missing accessToken');
  });
});

describe('getTokenExpiry', () => {
  test('parses JWT exp with a 5-minute margin', () => {
    const payload = { exp: Math.floor(Date.now() / 1000) + 3600 };
    const jwt = `header.${btoa(JSON.stringify(payload))}.sig`;
    const expiry = getTokenExpiry(jwt);
    // exp is 1h out; expiry is exp - 5min, so ~55min from now.
    expect(expiry).toBeLessThan(Date.now() + 3600 * 1000);
    expect(expiry).toBeGreaterThan(Date.now() + 50 * 60 * 1000);
  });

  test('falls back to ~1h for a non-JWT string', () => {
    expect(getTokenExpiry('not-a-jwt')).toBeGreaterThan(Date.now() + 3500 * 1000);
  });
});
