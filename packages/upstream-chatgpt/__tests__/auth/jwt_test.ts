import { describe, expect, test } from 'vitest';

import { parseChatGPTTokenClaims } from '../../src/auth/jwt.ts';

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

describe('parseChatGPTTokenClaims', () => {
  test('accepts top-level email when /profile is absent (observed real-world id_token shape)', () => {
    const token = makeJwt({
      'https://api.openai.com/auth': { chatgpt_account_id: 'a' },
      email: 'top-level@example.com',
    });
    expect(parseChatGPTTokenClaims(token, 'id_token').email).toBe('top-level@example.com');
  });

  test('rejects noncanonical JWT payload encodings', () => {
    const token = makeJwt({
      'https://api.openai.com/auth': { chatgpt_account_id: 'a', chatgpt_user_id: 'u', chatgpt_plan_type: 'plus' },
      'https://api.openai.com/profile': { email: 'a@b' },
      x: '',
    });
    const [header, payload, signature] = token.split('.');
    expect(payload?.endsWith('Q')).toBe(true);
    expect(() => parseChatGPTTokenClaims(`${header}.${payload}=.${signature}`, 'access_token')).toThrow();
    expect(() => parseChatGPTTokenClaims(`${header}.${payload}\n.${signature}`, 'access_token')).toThrow();
    expect(() => parseChatGPTTokenClaims(`${header}.${payload!.slice(0, -1)}R.${signature}`, 'access_token')).toThrow();
  });
});
