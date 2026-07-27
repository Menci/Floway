import { describe, expect, test } from 'vitest';

import { parseCodexIdTokenClaims } from '../../src/auth/jwt.ts';

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

describe('parseCodexIdTokenClaims', () => {
  test('extracts all identity claims', () => {
    const token = makeJwt({
      'https://api.openai.com/auth': {
        chatgpt_plan_type: 'plus',
        chatgpt_account_id: 'acc_123',
        chatgpt_user_id: 'user-abc',
      },
      'https://api.openai.com/profile': { email: 'a@b.com' },
    });
    expect(parseCodexIdTokenClaims(token)).toEqual({
      email: 'a@b.com',
      chatgptAccountId: 'acc_123',
      chatgptUserId: 'user-abc',
      planType: 'plus',
    });
  });

  test('rejects token without 3 segments', () => {
    expect(() => parseCodexIdTokenClaims('not.a.jwt.really')).toThrow(/3 segments/);
    expect(() => parseCodexIdTokenClaims('one.two')).toThrow(/3 segments/);
  });

  test('rejects token whose payload is not base64url-decodable JSON', () => {
    expect(() => parseCodexIdTokenClaims('aaa.!!!.bbb')).toThrow();
  });

  test('rejects token missing required claims', () => {
    const noAccountId = makeJwt({
      'https://api.openai.com/auth': { chatgpt_user_id: 'u', chatgpt_plan_type: 'plus' },
      'https://api.openai.com/profile': { email: 'a@b' },
    });
    expect(() => parseCodexIdTokenClaims(noAccountId)).toThrow(/chatgpt_account_id/);

    const noEmail = makeJwt({
      'https://api.openai.com/auth': { chatgpt_account_id: 'a', chatgpt_user_id: 'u', chatgpt_plan_type: 'plus' },
    });
    expect(() => parseCodexIdTokenClaims(noEmail)).toThrow(/email/);
  });

  test('accepts top-level email when /profile is absent (observed real-world id_token shape)', () => {
    const token = makeJwt({
      'https://api.openai.com/auth': { chatgpt_account_id: 'a', chatgpt_user_id: 'u', chatgpt_plan_type: 'plus' },
      email: 'top-level@example.com',
    });
    expect(parseCodexIdTokenClaims(token).email).toBe('top-level@example.com');
  });

  test('handles base64url padding-free encoding (real OpenAI tokens have no padding)', () => {
    // encodeBase64Url already strips padding, matching real OpenAI tokens.
    const token = makeJwt({
      'https://api.openai.com/auth': { chatgpt_account_id: 'a', chatgpt_user_id: 'u', chatgpt_plan_type: 'plus' },
      'https://api.openai.com/profile': { email: 'a@b' },
    });
    expect(parseCodexIdTokenClaims(token).chatgptAccountId).toBe('a');
  });
});
