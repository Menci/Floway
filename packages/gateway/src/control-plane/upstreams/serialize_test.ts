import { expect, test } from 'vitest';

import { upstreamRecordToFullJson, upstreamRecordToJson } from './serialize.ts';
import type { UpstreamRecord } from '@floway-dev/provider';
import { assertEquals } from '@floway-dev/test-utils';

const timestamp = '2026-04-29T00:00:00.000Z';

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
  config: {
    baseUrl: 'https://api.example.com',
    authStyle: 'bearer',
    apiKey: 'sk-secret-token-12345',
    endpoints: { chatCompletions: {}, responses: {} },
    modelsFetch: { enabled: true, endpoint: '/models' },
    models: [{ upstreamModelId: 'gpt-prod', endpoints: { chatCompletions: {} } }],
  },
  state: null,
};

test('upstreamRecordToJson redacts custom bearer token inside config', () => {
  const result = upstreamRecordToJson(custom);
  const config = result.config as Record<string, unknown>;

  assertEquals(result.id, 'up_custom_test');
  assertEquals(result.kind, 'custom');
  assertEquals(result.sort_order, 10);
  assertEquals(result.created_at, timestamp);
  assertEquals(result.updated_at, timestamp);
  assertEquals(result.flag_overrides, { 'vendor-deepseek': true });
  assertEquals(result.state, null);
  assertEquals(config.baseUrl, 'https://api.example.com');
  assertEquals(config.apiKey, undefined);
  assertEquals(config.apiKeySet, true);
  assertEquals(config.endpoints, { chatCompletions: {}, responses: {} });
  assertEquals(config.modelsFetch, { enabled: true, endpoint: '/models' });
  assertEquals(config.models, [{ upstreamModelId: 'gpt-prod', endpoints: { chatCompletions: {} } }]);
});

test('upstreamRecordToJson redacts Azure API keys inside config', () => {
  const result = upstreamRecordToJson({
    ...custom,
    id: 'up_azure_test',
    kind: 'azure',
    config: {
      endpoint: 'https://example.openai.azure.com',
      apiKey: 'az-secret',
      models: [{ upstreamModelId: 'gpt-prod', endpoints: { chatCompletions: {} } }],
    },
  });
  const config = result.config as Record<string, unknown>;

  assertEquals(result.kind, 'azure');
  assertEquals(config.endpoint, 'https://example.openai.azure.com');
  assertEquals(config.apiKey, undefined);
  assertEquals(config.apiKeySet, true);
  assertEquals(config.models, [{ upstreamModelId: 'gpt-prod', endpoints: { chatCompletions: {} } }]);
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
  const config = result.config as Record<string, unknown>;
  const state = result.state as Record<string, unknown>;

  assertEquals(result.kind, 'copilot');
  assertEquals(config.githubToken, undefined);
  assertEquals(config.githubTokenSet, true);
  assertEquals(config.accountType, undefined);
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
  const state = result.state as Record<string, unknown>;
  assertEquals(state.copilotToken, null);
});

test('upstreamRecordToFullJson includes provider config secrets for export', () => {
  const result = upstreamRecordToFullJson(custom);
  const config = result.config as Record<string, unknown>;

  assertEquals(result.id, 'up_custom_test');
  assertEquals(config.apiKey, 'sk-secret-token-12345');
  assertEquals(config.apiKeySet, undefined);
});

// Strict-throw helpers in serialize.ts fail loud rather than silently
// collapse shape drift into nulls. The list endpoint maps
// serializeForResponse over every row, so a single malformed row in
// production blocks `/api/upstreams`. These tests pin that contract.

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
  config: overrides.config ?? { accounts: [{ email: 'a@example.com' }] },
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
  config: overrides.config ?? { accounts: [{ email: 'a@example.com' }] },
  state: overrides.state ?? null,
} as unknown as UpstreamRecord);

test('upstreamRecordToJson throws when claude-code state.accessToken is a string', () => {
  const record = claudeCodeBase({
    state: { accounts: [{ accountUuid: 'u', tokenKind: 'oauth', state: 'active', stateUpdatedAt: timestamp, refreshToken: 'r', accessToken: 'not-an-object', quotaSnapshot: null }] },
  });
  expect(() => upstreamRecordToJson(record)).toThrow(/malformed accessToken/);
});

test('upstreamRecordToJson throws when claude-code state.quotaSnapshot is a string', () => {
  const record = claudeCodeBase({
    state: { accounts: [{ accountUuid: 'u', tokenKind: 'oauth', state: 'active', stateUpdatedAt: timestamp, refreshToken: 'r', accessToken: null, quotaSnapshot: 'not-an-object' }] },
  });
  expect(() => upstreamRecordToJson(record)).toThrow(/malformed quotaSnapshot/);
});

test('upstreamRecordToJson throws when claude-code config.accounts is not an array', () => {
  const record = claudeCodeBase({ config: { accounts: 'not-an-array' } });
  expect(() => upstreamRecordToJson(record)).toThrow(/malformed accounts/);
});

test('upstreamRecordToJson throws when claude-code state.accounts is not an array', () => {
  const record = claudeCodeBase({
    config: { accounts: [{ email: 'a@example.com' }] },
    state: { accounts: 'not-an-array' },
  });
  expect(() => upstreamRecordToJson(record)).toThrow(/malformed accounts/);
});

test('upstreamRecordToJson throws when codex config.accounts is not an array', () => {
  const record = codexBase({ config: { accounts: 'not-an-array' } });
  expect(() => upstreamRecordToJson(record)).toThrow(/malformed accounts/);
});

test('upstreamRecordToJson throws when codex state.accounts is not an array', () => {
  const record = codexBase({
    config: { accounts: [{ email: 'a@example.com' }] },
    state: { accounts: 'not-an-array' },
  });
  expect(() => upstreamRecordToJson(record)).toThrow(/malformed accounts/);
});
