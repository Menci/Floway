import { describe, expect, test } from 'vitest';

import { parseCodexTokenClaims, tryParseCodexAccessTokenClaims } from '../../src/auth/jwt.ts';

// Helper builds a minimal JWT with given payload. Signature segment is fake.
const encodeBase64Url = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};

const makeJwt = (payload: unknown): string => {
  const header = encodeBase64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = encodeBase64Url(JSON.stringify(payload));
  return `${header}.${body}.fake-signature`;
};

describe('parseCodexTokenClaims', () => {
  test('extracts every identity claim a full id_token carries', () => {
    const token = makeJwt({
      'https://api.openai.com/auth': {
        chatgpt_plan_type: 'plus',
        chatgpt_account_id: 'acc_123',
        chatgpt_user_id: 'user-abc',
      },
      'https://api.openai.com/profile': { email: 'a@b.com' },
    });
    expect(parseCodexTokenClaims(token, 'id_token')).toEqual({
      email: 'a@b.com',
      chatgptAccountId: 'acc_123',
      chatgptUserId: 'user-abc',
      planType: 'plus',
      expiresAt: null,
    });
  });

  test('reports a claim the token does not carry as null', () => {
    expect(parseCodexTokenClaims(makeJwt({}), 'id_token')).toEqual({
      email: null,
      chatgptAccountId: null,
      chatgptUserId: null,
      planType: null,
      expiresAt: null,
    });
  });

  test('converts exp seconds to milliseconds', () => {
    expect(parseCodexTokenClaims(makeJwt({ exp: 2_000_000_000 })).expiresAt).toBe(2_000_000_000_000);
  });

  test('rejects a token without 3 segments', () => {
    expect(() => parseCodexTokenClaims('not.a.jwt.really', 'id_token')).toThrow(/3 segments/);
    expect(() => parseCodexTokenClaims('one.two', 'id_token')).toThrow(/3 segments/);
  });

  test('rejects a token whose payload is not base64url-decodable JSON', () => {
    expect(() => parseCodexTokenClaims('aaa.!!!.bbb', 'id_token')).toThrow();
  });

  test('accepts top-level email when /profile is absent (observed real-world id_token shape)', () => {
    const token = makeJwt({
      'https://api.openai.com/auth': { chatgpt_account_id: 'a' },
      email: 'top-level@example.com',
    });
    expect(parseCodexTokenClaims(token, 'id_token').email).toBe('top-level@example.com');
  });

  test('handles base64url padding-free encoding (real OpenAI tokens have no padding)', () => {
    // encodeBase64Url already strips padding, matching real OpenAI tokens.
    const token = makeJwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'a' } });
    expect(parseCodexTokenClaims(token, 'id_token').chatgptAccountId).toBe('a');
  });
});

describe('tryParseCodexAccessTokenClaims', () => {
  test('reads an opaque access token as carrying no claims rather than failing', () => {
    expect(tryParseCodexAccessTokenClaims('opaque-access-token')).toBeNull();
  });

  test('reads claims off an access token that is a JWT', () => {
    const token = makeJwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acc_from_access' } });
    expect(tryParseCodexAccessTokenClaims(token)?.chatgptAccountId).toBe('acc_from_access');
  });

  test('rejects noncanonical JWT payload encodings', () => {
    const token = makeJwt({
      'https://api.openai.com/auth': { chatgpt_account_id: 'a', chatgpt_user_id: 'u', chatgpt_plan_type: 'plus' },
      'https://api.openai.com/profile': { email: 'a@b' },
      x: '',
    });
    const [header, payload, signature] = token.split('.');
    expect(payload?.endsWith('Q')).toBe(true);
    expect(() => parseCodexTokenClaims(`${header}.${payload}=.${signature}`, 'access_token')).toThrow();
    expect(() => parseCodexTokenClaims(`${header}.${payload}\n.${signature}`, 'access_token')).toThrow();
    expect(() => parseCodexTokenClaims(`${header}.${payload!.slice(0, -1)}R.${signature}`, 'access_token')).toThrow();
  });
});
