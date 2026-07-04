import { describe, expect, test } from 'vitest';

import { generateCursorAuthParams, pollCursorAuth } from './poll.ts';
import type { Fetcher } from '@floway-dev/provider';

describe('generateCursorAuthParams', () => {
  test('produces verifier/challenge/uuid/loginUrl', async () => {
    const p = await generateCursorAuthParams();
    expect(p.verifier.length).toBeGreaterThan(0);
    expect(p.challenge.length).toBeGreaterThan(0);
    expect(p.uuid).toMatch(/^[0-9a-f-]{36}$/i);
    expect(p.loginUrl).toContain('cursor.com/loginDeepControl');
    expect(p.loginUrl).toContain(`uuid=${p.uuid}`);
    expect(p.loginUrl).toContain(`challenge=${encodeURIComponent(p.challenge)}`);
    expect(p.loginUrl).toContain('mode=login');
    expect(p.loginUrl).toContain('redirectTarget=cli');
  });

  test('challenge is the base64url sha256 of the verifier', async () => {
    const p = await generateCursorAuthParams();
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(p.verifier)));
    // base64url of hash, no padding
    const expected = btoa(String.fromCharCode(...hash)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(p.challenge).toBe(expected);
  });
});

describe('pollCursorAuth', () => {
  test('returns tokens when the poll resolves 200', async () => {
    const fetcher: Fetcher = (async () =>
      new Response(JSON.stringify({ accessToken: 'a', refreshToken: 'r' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as Fetcher;
    const tokens = await pollCursorAuth('uuid', 'verifier', fetcher);
    expect(tokens.accessToken).toBe('a');
    expect(tokens.refreshToken).toBe('r');
  });
});
