import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  importChatGPTFromCallback,
  importChatGPTFromJson,
  importChatGPTFromManual,
  parseSourceExpiry,
  previewChatGPTJson,
} from '../../src/auth/import.ts';
import { directFetcher } from '@floway-dev/provider';

const encodeBase64Url = (input: string): string => btoa(input)
  .replace(/\+/g, '-')
  .replace(/\//g, '_')
  .replace(/=+$/, '');

const makeJwt = (payload: unknown): string => {
  const header = encodeBase64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = encodeBase64Url(JSON.stringify(payload));
  return `${header}.${body}.fake-signature`;
};

const identityPayload = {
  'https://api.openai.com/auth': { chatgpt_plan_type: 'plus', chatgpt_account_id: 'account', chatgpt_user_id: 'user' },
  'https://api.openai.com/profile': { email: 'person@example.test' },
};

const credential = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  access_token: makeJwt({ ...identityPayload, exp: 2_000_000_000 }),
  refresh_token: 'refresh-token',
  id_token: makeJwt(identityPayload),
  ...overrides,
});

afterEach(() => vi.restoreAllMocks());

describe('ChatGPT JSON import', () => {
  test.each([
    ['ChatGPT auth JSON', (value: Record<string, unknown>) => ({ tokens: value })],
    ['accounts envelope', (value: Record<string, unknown>) => ({ accounts: [{ platform: 'openai', type: 'oauth', credentials: value }] })],
  ])('previews and imports %s', async (_label, envelope) => {
    const raw = JSON.stringify(envelope(credential()));
    const preview = await previewChatGPTJson(raw);
    expect(preview).toEqual([expect.objectContaining({
      sourceIndex: 0,
      chatgptAccountId: 'account',
      renewable: true,
      issues: [],
    })]);

    const result = await importChatGPTFromJson(raw, 0);
    expect(result.config.accounts).toEqual([{
      email: 'person@example.test',
      chatgptAccountId: 'account',
      chatgptUserId: 'user',
      planType: 'plus',
    }]);
    expect(result.state.accounts[0].refresh_token).toBe('refresh-token');
    expect(result.state.accounts[0].accessToken).toMatchObject({
      expiresAt: 2_000_000_000_000,
      planType: 'plus',
    });
    expect(result.state.accounts[0].accessToken?.planObservedAt).toBe(result.state.accounts[0].accessToken?.refreshedAt);
    expect(result.state.accounts[0].openaiDeviceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test('rejects malformed, unsupported, or incomplete JSON', async () => {
    await expect(previewChatGPTJson('not json')).rejects.toThrow(/not valid JSON/);
    await expect(previewChatGPTJson('null')).rejects.toThrow();
    await expect(previewChatGPTJson('{}')).rejects.toThrow(/supported structure/);
    const preview = await previewChatGPTJson(JSON.stringify({ tokens: { account_id: 'account' } }));
    expect(preview[0].issues).toEqual([expect.stringMatching(/access_token/)]);
  });
});

describe('manual ChatGPT import', () => {
  test('requires only access token when its JWT carries the account ID', async () => {
    const result = await importChatGPTFromManual({ access_token: makeJwt(identityPayload) });
    expect(result.config.accounts[0].chatgptAccountId).toBe('account');
    expect(result.state.accounts[0].refresh_token).toBeNull();
  });
});

describe('ChatGPT JSON account selection', () => {
  test('preserves source indexes while filtering non-OpenAI accounts', async () => {
    const raw = JSON.stringify({
      accounts: [
        { platform: 'anthropic', type: 'oauth', credentials: { access_token: 'ignored' } },
        { platform: 'openai', type: 'oauth', credentials: credential({ chatgpt_account_id: 'selected' }) },
      ],
    });
    const preview = await previewChatGPTJson(raw);
    expect(preview.map(candidate => candidate.sourceIndex)).toEqual([1]);
    const result = await importChatGPTFromJson(raw, 1);
    expect(result.config.accounts[0].chatgptAccountId).toBe('selected');
  });

  test('previews an opaque credential without an account ID without exposing it', async () => {
    const raw = JSON.stringify({
      accounts: [{
        platform: 'openai', type: 'oauth', credentials: { access_token: 'private-value' },
      }],
    });
    const preview = await previewChatGPTJson(raw);
    expect(preview[0]).toMatchObject({ chatgptAccountId: null, issues: [] });
    expect(JSON.stringify(preview)).not.toContain('private-value');
    const result = await importChatGPTFromJson(raw, 0);
    expect(result.config.accounts[0].chatgptAccountId).toBeNull();
    expect(result.state.accounts[0].chatgptAccountId).toBeNull();
  });

  test.each([
    { tokens: credential(), credentials: credential() },
  ])('rejects ambiguous structures', async value => {
    await expect(previewChatGPTJson(JSON.stringify(value))).rejects.toThrow(/ambiguous/);
  });

  test('rejects invalid indexes and unsupported selected accounts', async () => {
    const single = JSON.stringify({ tokens: credential() });
    await expect(importChatGPTFromJson(single, -1)).rejects.toThrow(/non-negative integer/);
    await expect(importChatGPTFromJson(single, 1)).rejects.toThrow(/does not exist/);
    await expect(importChatGPTFromJson(JSON.stringify({ accounts: [] }), 0)).rejects.toThrow(/does not exist/);
    await expect(importChatGPTFromJson(JSON.stringify({
      accounts: [{
        platform: 'anthropic', type: 'oauth', credentials: credential(),
      }],
    }), 0)).rejects.toThrow(/not an OpenAI OAuth account/);
  });
});

describe('parseSourceExpiry', () => {
  test.each([
    [2_000_000_000, 2_000_000_000_000],
    ['2030-01-01T00:00:00.000Z', Date.parse('2030-01-01T00:00:00.000Z')],
    [0, null],
    [null, null],
  ])('normalizes %j', (input, expected) => {
    expect(parseSourceExpiry(input)).toBe(expected);
  });
});

describe('importChatGPTFromCallback', () => {
  test('exchanges code and returns config plus state', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      access_token: 'opaque-access', refresh_token: 'refresh-token', id_token: makeJwt(identityPayload), expires_in: 600,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const result = await importChatGPTFromCallback({ code: 'CODE', codeVerifier: 'VER', fetcher: directFetcher });
    expect(result.config.accounts[0].email).toBe('person@example.test');
    expect(result.state.accounts[0].refresh_token).toBe('refresh-token');
    expect(result.state.accounts[0].accessToken?.token).toBe('opaque-access');
    // The imported token entry is seeded with the import-time plan observation.
    expect(result.state.accounts[0].accessToken?.planType).toBe('plus');
    expect(result.state.accounts[0].accessToken?.planObservedAt).toBe(result.state.accounts[0].accessToken?.refreshedAt);
    expect(result.state.accounts[0].openaiDeviceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
