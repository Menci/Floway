import { describe, expect, test } from 'vitest';

import { normalizeCodexCredential } from '../../src/auth/credential.ts';

const encodeBase64Url = (text: string): string => btoa(text)
  .replace(/\+/g, '-')
  .replace(/\//g, '_')
  .replace(/=+$/g, '');

const makeJwt = (payload: unknown): string => `${encodeBase64Url(JSON.stringify({ alg: 'none' }))}.${encodeBase64Url(JSON.stringify(payload))}.signature`;

const claims = (accountId: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  'https://api.openai.com/auth': {
    chatgpt_account_id: accountId,
    chatgpt_user_id: `${accountId}-user`,
    chatgpt_plan_type: 'plus',
  },
  email: `${accountId}@example.test`,
  ...extra,
});

describe('normalizeCodexCredential', () => {
  test('accepts an opaque access token with an explicit account ID', () => {
    expect(normalizeCodexCredential({ accessToken: 'opaque', chatgptAccountId: 'account' })).toEqual({
      accessToken: 'opaque',
      refreshToken: null,
      expiresAt: null,
      identity: {
        chatgptAccountId: 'account',
        email: null,
        chatgptUserId: null,
        planType: null,
      },
    });
  });

  test('operator-typed identity wins over both id_token and access_token claims', () => {
    const result = normalizeCodexCredential({
      accessToken: makeJwt(claims('access', { exp: 2_000_000_000 })),
      idToken: makeJwt(claims('id')),
      chatgptAccountId: 'explicit',
      chatgptUserId: 'explicit-user',
      email: 'explicit@example.test',
      planType: 'team',
    });
    expect(result.identity).toEqual({
      chatgptAccountId: 'explicit',
      chatgptUserId: 'explicit-user',
      email: 'explicit@example.test',
      planType: 'team',
    });
    expect(result.expiresAt).toBe(2_000_000_000_000);
  });

  test('id_token claims fill in identity when nothing was typed, and beat access_token claims', () => {
    // Same account id in both JWTs so the mismatch guard stays off. id_token
    // and access_token both carry email so we can confirm id wins the tie;
    // only access_token carries plan and user id so we also confirm
    // access_token still fills in what id_token leaves blank.
    const result = normalizeCodexCredential({
      accessToken: makeJwt({
        'https://api.openai.com/auth': {
          chatgpt_account_id: 'shared',
          chatgpt_user_id: 'access-user',
          chatgpt_plan_type: 'pro',
        },
        email: 'access@example.test',
      }),
      idToken: makeJwt({
        'https://api.openai.com/auth': { chatgpt_account_id: 'shared' },
        email: 'id@example.test',
      }),
    });
    expect(result.identity).toEqual({
      chatgptAccountId: 'shared',
      chatgptUserId: 'access-user',
      email: 'id@example.test',
      planType: 'pro',
    });
  });

  test('uses source expiry only when the access token has no exp claim', () => {
    const result = normalizeCodexCredential({
      accessToken: 'opaque',
      chatgptAccountId: 'account',
      expiresAt: 1_900_000_000_000,
    });
    expect(result.expiresAt).toBe(1_900_000_000_000);
  });

  test('rejects conflicting inferred account IDs', () => {
    expect(() => normalizeCodexCredential({
      accessToken: makeJwt(claims('access')),
      idToken: makeJwt(claims('id')),
    })).toThrow(/different ChatGPT accounts/);
  });

  test('lets an explicit account ID settle a conflict between the two tokens', () => {
    expect(normalizeCodexCredential({
      accessToken: makeJwt(claims('access')),
      idToken: makeJwt(claims('id')),
      chatgptAccountId: 'operator-choice',
    }).identity.chatgptAccountId).toBe('operator-choice');
  });

  test('keeps the account ID null when no token can provide one', () => {
    expect(normalizeCodexCredential({ accessToken: 'opaque' }).identity).toEqual({
      chatgptAccountId: null,
      email: null,
      chatgptUserId: null,
      planType: null,
    });
  });

  test('rejects an empty access token', () => {
    expect(() => normalizeCodexCredential({ accessToken: '' })).toThrow(/access token/);
  });
});
