import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  importCodexFromCallback,
  importCodexFromJson,
  importCodexFromManual,
  parseSourceExpiry,
  previewCodexJson,
} from '../../src/auth/import.ts';
import { directFetcher, type Fetcher } from '@floway-dev/provider';

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

describe('Codex JSON import', () => {
  test.each([
    ['Codex auth JSON', (value: Record<string, unknown>) => ({ tokens: value })],
    ['root account', (value: Record<string, unknown>) => ({ name: 'Primary', platform: 'openai', type: 'oauth', credentials: value })],
    ['accounts envelope', (value: Record<string, unknown>) => ({ accounts: [{ platform: 'openai', type: 'oauth', credentials: value }] })],
    ['data.accounts envelope', (value: Record<string, unknown>) => ({ data: { accounts: [{ platform: 'openai', type: 'oauth', credentials: value }] } })],
  ])('previews and imports %s', async (_label, envelope) => {
    const raw = JSON.stringify(envelope(credential()));
    const preview = await previewCodexJson(raw);
    expect(preview).toEqual([expect.objectContaining({
      sourceIndex: 0,
      chatgptAccountId: 'account',
      renewable: true,
      issues: [],
    })]);

    const result = await importCodexFromJson(raw, 0);
    expect(result.config.accounts).toEqual([{
      email: 'person@example.test',
      chatgptAccountId: 'account',
      chatgptUserId: 'user',
      planType: 'plus',
    }]);
    expect(result.state.accounts[0].refresh_token).toBe('refresh-token');
    expect(result.state.accounts[0].accessToken).toMatchObject({
      expiresAt: 2_000_000_000_000,
    });
    expect(result.state.accounts[0].openaiDeviceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test('accepts access-token-only Codex auth JSON', async () => {
    const result = await importCodexFromJson(JSON.stringify({
      tokens: { access_token: makeJwt({ ...identityPayload, exp: 2_000_000_000 }) },
    }), 0);
    expect(result.state.accounts[0].refresh_token).toBeNull();
    expect(result.config.accounts[0].chatgptAccountId).toBe('account');
  });

  test('accepts an opaque auth token when account_id is explicit', async () => {
    const result = await importCodexFromJson(JSON.stringify({
      tokens: { access_token: 'opaque', account_id: 'explicit-account' },
    }), 0);
    expect(result.config.accounts[0]).toEqual({
      chatgptAccountId: 'explicit-account',
      email: null,
      chatgptUserId: null,
      planType: null,
    });
    expect(result.state.accounts[0].accessToken?.expiresAt).toBeNull();
  });

  test('rejects malformed, unsupported, or incomplete JSON', async () => {
    await expect(previewCodexJson('not json')).rejects.toThrow(/not valid JSON/);
    await expect(previewCodexJson('null')).rejects.toThrow();
    await expect(previewCodexJson('{}')).rejects.toThrow(/supported structure/);
    const preview = await previewCodexJson(JSON.stringify({ tokens: { account_id: 'account' } }));
    expect(preview[0].issues).toEqual([expect.stringMatching(/access_token/)]);
  });
});

describe('manual Codex import', () => {
  test('requires only access token when its JWT carries the account ID', async () => {
    const result = await importCodexFromManual({ access_token: makeJwt(identityPayload) });
    expect(result.config.accounts[0].chatgptAccountId).toBe('account');
    expect(result.state.accounts[0].refresh_token).toBeNull();
  });

  test('accepts an opaque access token without an account ID', async () => {
    const result = await importCodexFromManual({ access_token: 'opaque' });
    expect(result.config.accounts[0].chatgptAccountId).toBeNull();
    expect(result.state.accounts[0].chatgptAccountId).toBeNull();
  });

  test('accepts an opaque access token plus explicit account ID and ISO expiry', async () => {
    const result = await importCodexFromManual({
      access_token: 'opaque',
      account_id: 'explicit-account',
      expires_at: '2030-01-01T00:00:00.000Z',
    });
    expect(result.state.accounts[0].accessToken?.expiresAt).toBe(Date.parse('2030-01-01T00:00:00.000Z'));
  });

  test('accepts optional email and plan for an opaque credential', async () => {
    const result = await importCodexFromManual({
      access_token: 'opaque',
      account_id: 'account',
      email: 'operator@example.test',
      plan_type: 'team',
    });
    expect(result.config.accounts[0]).toMatchObject({
      chatgptAccountId: 'account',
      email: 'operator@example.test',
      planType: 'team',
    });
  });

  test('operator-typed email and plan win over JWT identity claims', async () => {
    const result = await importCodexFromManual({
      access_token: makeJwt(identityPayload),
      email: 'typed@example.test',
      plan_type: 'team',
    });
    expect(result.config.accounts[0]).toMatchObject({
      email: 'typed@example.test',
      planType: 'team',
    });
  });
});

describe('Codex JSON account selection', () => {
  test('preserves source indexes while filtering non-OpenAI accounts', async () => {
    const raw = JSON.stringify({
      accounts: [
        { platform: 'anthropic', type: 'oauth', credentials: { access_token: 'ignored' } },
        { platform: 'openai', type: 'oauth', credentials: credential({ chatgpt_account_id: 'selected' }) },
      ],
    });
    const preview = await previewCodexJson(raw);
    expect(preview.map(candidate => candidate.sourceIndex)).toEqual([1]);
    const result = await importCodexFromJson(raw, 1);
    expect(result.config.accounts[0].chatgptAccountId).toBe('selected');
  });

  test('previews an opaque credential without an account ID without exposing it', async () => {
    const raw = JSON.stringify({
      accounts: [{
        platform: 'openai', type: 'oauth', credentials: { access_token: 'private-value' },
      }],
    });
    const preview = await previewCodexJson(raw);
    expect(preview[0]).toMatchObject({ chatgptAccountId: null, issues: [] });
    expect(JSON.stringify(preview)).not.toContain('private-value');
    const result = await importCodexFromJson(raw, 0);
    expect(result.config.accounts[0].chatgptAccountId).toBeNull();
    expect(result.state.accounts[0].chatgptAccountId).toBeNull();
  });

  test.each([
    { tokens: credential(), credentials: credential() },
    { tokens: credential(), accounts: [] },
    { credentials: credential(), data: { accounts: [] } },
    { accounts: [], data: { accounts: [] } },
  ])('rejects ambiguous structures', async value => {
    await expect(previewCodexJson(JSON.stringify(value))).rejects.toThrow(/ambiguous/);
  });

  test('rejects invalid indexes and unsupported selected accounts', async () => {
    const single = JSON.stringify({ tokens: credential() });
    await expect(importCodexFromJson(single, -1)).rejects.toThrow(/non-negative integer/);
    await expect(importCodexFromJson(single, 1)).rejects.toThrow(/does not exist/);
    await expect(importCodexFromJson(JSON.stringify({ accounts: [] }), 0)).rejects.toThrow(/does not exist/);
    await expect(importCodexFromJson(JSON.stringify({
      accounts: [{
        platform: 'anthropic', type: 'oauth', credentials: credential(),
      }],
    }), 0)).rejects.toThrow(/not an OpenAI OAuth account/);
  });
});

describe('parseSourceExpiry', () => {
  test.each([
    [2_000_000_000, 2_000_000_000_000],
    ['2000000000', 2_000_000_000_000],
    ['2030-01-01T00:00:00.000Z', Date.parse('2030-01-01T00:00:00.000Z')],
    [0, null],
    ['', null],
    [null, null],
  ])('normalizes %j', (input, expected) => {
    expect(parseSourceExpiry(input)).toBe(expected);
  });
});

describe('importCodexFromCallback', () => {
  test('exchanges code and returns config plus state', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      access_token: 'opaque-access', refresh_token: 'refresh-token', id_token: makeJwt(identityPayload), expires_in: 600,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const result = await importCodexFromCallback({ code: 'CODE', codeVerifier: 'VER', fetcher: directFetcher });
    expect(result.config.accounts[0].email).toBe('person@example.test');
    expect(result.state.accounts[0].refresh_token).toBe('refresh-token');
  });

  test('accepts an id token without identity claims', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      access_token: 'opaque-access', refresh_token: 'refresh-token', id_token: makeJwt({}), expires_in: 600,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const result = await importCodexFromCallback({ code: 'CODE', codeVerifier: 'VER', fetcher: directFetcher });
    expect(result.config.accounts[0].chatgptAccountId).toBeNull();
    expect(result.config.accounts[0].email).toBeNull();
  });

  test('routes the token exchange through the supplied fetcher', async () => {
    const fetcher = vi.fn<Fetcher>(async () => new Response(JSON.stringify({
      access_token: 'opaque-access', refresh_token: 'refresh-token', id_token: makeJwt(identityPayload), expires_in: 600,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await importCodexFromCallback({ code: 'CODE', codeVerifier: 'VER', fetcher });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe('https://auth.openai.com/oauth/token');
  });
});
