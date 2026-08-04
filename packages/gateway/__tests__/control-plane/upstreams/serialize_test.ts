import { expect, expectTypeOf, test } from 'vitest';

import { upstreamRecordToFullJson, upstreamRecordToJson, type FullSerializedUpstreamRecord } from '../../../src/control-plane/upstreams/serialize.ts';
import type { RedactedSerializedUpstreamRecord } from '../../../src/control-plane/upstreams/types.ts';
import type { UpstreamRecord } from '@floway-dev/provider';
import { assertEquals } from '@floway-dev/test-utils';

const timestamp = '2026-04-29T00:00:00.000Z';

test('serialized records exclude route-layer response projections and redacted access tokens', () => {
  expectTypeOf<'modelsCache' extends keyof FullSerializedUpstreamRecord ? true : false>().toEqualTypeOf<false>();
  expectTypeOf<'codex_quota' extends keyof FullSerializedUpstreamRecord ? true : false>().toEqualTypeOf<false>();
  type ClaudeState = Extract<RedactedSerializedUpstreamRecord, { kind: 'claude-code' }>['state'];
  type AccessToken = ClaudeState['accounts'][number]['accessToken'];
  expectTypeOf<'token' extends keyof NonNullable<AccessToken> ? true : false>().toEqualTypeOf<false>();
});

const custom: UpstreamRecord = {
  id: 'up_custom_test',
  kind: 'custom',
  name: 'Custom Upstream',
  enabled: true,
  sortOrder: 10,
  createdAt: timestamp,
  updatedAt: timestamp,
  flagOverrides: { 'vendor-deepseek': true },
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  modelsCache: null,
  hue: 210,
  config: {
    baseUrl: 'https://api.example.com',
    authStyle: 'bearer',
    apiKey: 'sk-secret-token-12345',
    endpoints: { chatCompletions: {}, responses: {} },
    modelsFetch: { enabled: true, endpoint: '/models' },
    models: [{ upstreamModelId: 'gpt-prod', kind: 'chat', endpoints: { chatCompletions: {} } }],
  },
  state: null,
};

test('upstreamRecordToJson redacts custom bearer token inside config', () => {
  const result = upstreamRecordToJson(custom);
  if (result.kind !== 'custom') throw new Error('Expected a Custom response');
  const { config } = result;

  assertEquals(result.id, 'up_custom_test');
  assertEquals(result.kind, 'custom');
  assertEquals(result.sort_order, 10);
  assertEquals(result.created_at, timestamp);
  assertEquals(result.updated_at, timestamp);
  assertEquals(result.flag_overrides, { 'vendor-deepseek': true });
  assertEquals(result.state, null);
  assertEquals(config.baseUrl, 'https://api.example.com');
  assertEquals('apiKey' in config, false);
  assertEquals(config.apiKeySet, true);
  assertEquals(config.endpoints, { chatCompletions: {}, responses: {} });
  assertEquals(config.modelsFetch, { enabled: true, endpoint: '/models' });
  assertEquals(config.models, [{ upstreamModelId: 'gpt-prod', kind: 'chat', endpoints: { chatCompletions: {} } }]);
});

test('upstreamRecordToJson redacts Azure API keys inside config', () => {
  const result = upstreamRecordToJson({
    ...custom,
    id: 'up_azure_test',
    kind: 'azure',
    config: {
      endpoint: 'https://example.openai.azure.com',
      apiKey: 'az-secret',
      models: [{ upstreamModelId: 'gpt-prod', kind: 'chat', endpoints: { chatCompletions: {} } }],
    },
  });
  if (result.kind !== 'azure') throw new Error('Expected an Azure response');
  const { config } = result;
  assertEquals(config.endpoint, 'https://example.openai.azure.com');
  assertEquals('apiKey' in config, false);
  assertEquals(config.apiKeySet, true);
  assertEquals(config.models, [{ upstreamModelId: 'gpt-prod', kind: 'chat', endpoints: { chatCompletions: {} } }]);
});

test('upstreamRecordToJson redacts Copilot GitHub token inside config and exposes the state baseUrl', () => {
  const result = upstreamRecordToJson({
    ...custom,
    id: 'up_copilot_test',
    kind: 'copilot',
    config: {
      githubToken: 'ghu_secret',
      user: {
        id: 100,
        login: 'octo',
        name: null,
        avatar_url: 'https://example.com/avatar.png',
      },
    },
    state: {
      copilotToken: { token: 'tok-secret', expiresAt: 4102444800, baseUrl: 'https://api.enterprise.githubcopilot.com' },
    },
  });
  assertEquals(result.kind, 'copilot');
  if (result.kind !== 'copilot' || result.state === null) throw new Error('Expected a Copilot response with state');
  const { config, state } = result;
  assertEquals('githubToken' in config, false);
  assertEquals(config.githubTokenSet, true);
  assertEquals('accountType' in config, false);
  assertEquals(config.user, {
    id: 100,
    login: 'octo',
    name: null,
    avatar_url: 'https://example.com/avatar.png',
  });
  // baseUrl surfaces; bearer token and expiry stay server-side.
  assertEquals(state.copilotToken, { baseUrl: 'https://api.enterprise.githubcopilot.com' });
});

test('upstreamRecordToJson serializes a Copilot row with state=null without throwing', () => {
  const result = upstreamRecordToJson({
    ...custom,
    id: 'up_copilot_fresh',
    kind: 'copilot',
    config: {
      githubToken: 'ghu_secret',
      user: { id: 200, login: 'fresh', name: null, avatar_url: 'https://example.com/fresh.png' },
    },
    state: null,
  });

  assertEquals(result.kind, 'copilot');
  // A freshly imported Copilot row that hasn't completed its first token
  // exchange yet has no state at all — the dashboard renders the generic
  // 'copilot' badge in that case rather than a per-tier label.
  assertEquals(result.state, null);
});

test('upstreamRecordToJson serializes a Copilot row whose state lacks copilotToken as { copilotToken: null }', () => {
  const result = upstreamRecordToJson({
    ...custom,
    id: 'up_copilot_no_token',
    kind: 'copilot',
    config: {
      githubToken: 'ghu_secret',
      user: { id: 201, login: 'no-token', name: null, avatar_url: 'https://example.com/n.png' },
    },
    state: { knownModels: null, copilotToken: null },
  });
  if (result.kind !== 'copilot' || result.state === null) throw new Error('Expected a Copilot response with state');
  const { state } = result;
  assertEquals(state.copilotToken, null);
});

test('upstreamRecordToFullJson includes provider config secrets for export', () => {
  const result = upstreamRecordToFullJson(custom);
  if (result.kind !== 'custom') throw new Error('Expected a Custom response');
  const { config } = result;
  if (config.authStyle === 'none') throw new Error('Expected an authenticated Custom response');
  assertEquals(result.id, 'up_custom_test');
  assertEquals(config.apiKey, 'sk-secret-token-12345');
  assertEquals('apiKeySet' in config, false);
});

// Serialization validates every provider-owned config and state slot, so a
// malformed persisted row blocks `/api/upstreams` instead of being redacted
// into an apparently valid response.

const claudeCodeConfig = {
  accounts: [{
    email: 'a@example.com',
    accountUuid: 'u',
    organizationUuid: null,
    subscriptionType: 'pro',
    rateLimitTier: 'default_claude_pro',
  }],
};

const claudeCodeCredential = {
  accountUuid: 'u',
  tokenKind: 'oauth',
  state: 'active',
  stateUpdatedAt: timestamp,
  refreshToken: 'r',
  accessToken: null,
  quotaSnapshot: null,
  usageProbeSnapshot: null,
};

const claudeCodeBase = (overrides: { config?: unknown; state?: unknown }): UpstreamRecord => ({
  id: 'up_cc_test',
  kind: 'claude-code',
  name: 'Claude Code',
  enabled: true,
  sortOrder: 0,
  createdAt: timestamp,
  updatedAt: timestamp,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  modelsCache: null,
  hue: 210,
  config: overrides.config ?? claudeCodeConfig,
  state: overrides.state ?? null,
} as unknown as UpstreamRecord);

const codexBase = (overrides: { config?: unknown; state?: unknown }): UpstreamRecord => ({
  id: 'up_cx_test',
  kind: 'codex',
  name: 'Codex',
  enabled: true,
  sortOrder: 0,
  createdAt: timestamp,
  updatedAt: timestamp,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  modelsCache: null,
  hue: 210,
  config: overrides.config ?? { accounts: [{ email: 'a@example.com', chatgptAccountId: 'account', chatgptUserId: 'user', planType: 'plus' }] },
  state: overrides.state ?? null,
} as unknown as UpstreamRecord);

test('upstreamRecordToJson throws when claude-code state.accessToken is a string', () => {
  const record = claudeCodeBase({
    state: { accounts: [{ ...claudeCodeCredential, accessToken: 'not-an-object' }] },
  });
  expect(() => upstreamRecordToJson(record)).toThrow(/accessToken must be a plain object/);
});

test('upstreamRecordToJson throws when claude-code state.quotaSnapshot is a string', () => {
  const record = claudeCodeBase({
    state: { accounts: [{ ...claudeCodeCredential, quotaSnapshot: 'not-an-object' }] },
  });
  expect(() => upstreamRecordToJson(record)).toThrow(/quotaSnapshot must be a plain object/);
});

test('upstreamRecordToJson throws when claude-code config.accounts is not an array', () => {
  const record = claudeCodeBase({ config: { accounts: 'not-an-array' } });
  expect(() => upstreamRecordToJson(record)).toThrow(/accounts must be an array/);
});

test('upstreamRecordToJson throws when claude-code state.accounts is not an array', () => {
  const record = claudeCodeBase({
    config: claudeCodeConfig,
    state: { accounts: 'not-an-array' },
  });
  expect(() => upstreamRecordToJson(record)).toThrow(/accounts must be an array/);
});

test('upstreamRecordToJson throws when codex config.accounts is not an array', () => {
  const record = codexBase({ config: { accounts: 'not-an-array' } });
  expect(() => upstreamRecordToJson(record)).toThrow(/accounts must be an array/);
});

test('upstreamRecordToJson throws when codex state.accounts is not an array', () => {
  const record = codexBase({
    state: { accounts: 'not-an-array' },
  });
  expect(() => upstreamRecordToJson(record)).toThrow(/accounts must be an array/);
});

test('persisted subscription upstreams require credential state', () => {
  expect(() => upstreamRecordToJson(codexBase({}))).toThrow(/CodexUpstreamState must be a plain object/);
  expect(() => upstreamRecordToFullJson(claudeCodeBase({}))).toThrow(/ClaudeCodeUpstreamState must be a plain object/);
});
