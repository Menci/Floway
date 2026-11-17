import { expect, test } from 'vitest';

import { upstreamRecordToFullJson, upstreamRecordToJson } from '../../../src/control-plane/upstreams/serialize.ts';
import type { UpstreamRecord } from '@floway-dev/provider';
import { assertEquals } from '@floway-dev/test-utils';

const timestamp = '2026-04-29T00:00:00.000Z';

const custom: UpstreamRecord = {
  id: 'up_custom_test',
  kind: 'custom',
  name: 'Custom Upstream',
  enabled: true,
  usageRefreshIntervalMinutes: 0,
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
    ingressHeadersRules: [{ key: 'x-route', value: '' }],
    apiKey: 'sk-secret-token-12345',
    endpoints: { openaiChatCompletions: {}, openaiResponses: {} },
    modelsFetch: { enabled: true, authStyle: 'bearer', endpoint: '/models' },
    models: [{ upstreamModelId: 'gpt-prod', kind: 'chat', endpoints: { openaiChatCompletions: {} } }],
  },
  state: null,
};

test('upstreamRecordToJson redacts Copilot GitHub token inside config and exposes the state baseUrl', () => {
  const result = upstreamRecordToJson({
    ...custom,
    id: 'up_copilot_test',
    kind: 'copilot',
    config: {
      githubHost: 'github.com',
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
  usageRefreshIntervalMinutes: 0,
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

const chatgptBase = (overrides: { config?: unknown; state?: unknown }): UpstreamRecord => ({
  id: 'up_cx_test',
  kind: 'chatgpt',
  name: 'ChatGPT',
  enabled: true,
  usageRefreshIntervalMinutes: 0,
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

test('upstreamRecordToJson exposes ChatGPT capability and bearer timing without the bearer', () => {
  const result = upstreamRecordToJson(chatgptBase({
    config: {
      accounts: [{ email: null, chatgptAccountId: null, chatgptUserId: null, planType: null }],
    },
    state: {
      accounts: [{
        chatgptAccountId: null,
        refresh_token: null,
        state: 'active',
        state_updated_at: timestamp,
        openaiDeviceId: 'device',
        accessToken: { token: 'bearer-secret', expiresAt: null, refreshedAt: timestamp },
        quotaSnapshot: null,
      }],
    },
  }));
  const configAccount = (result.config as unknown as { accounts: Array<Record<string, unknown>> }).accounts[0];
  const account = (result.state as unknown as { accounts: Array<Record<string, unknown>> }).accounts[0];
  assertEquals(configAccount.chatgptAccountId, null);
  assertEquals(account.chatgptAccountId, null);
  assertEquals(account.refresh_token_set, false);
  assertEquals(account.accessToken, { expiresAt: null, refreshedAt: timestamp });
  assertEquals(JSON.stringify(result).includes('bearer-secret'), false);
});

test('persisted subscription upstreams require credential state', () => {
  expect(() => upstreamRecordToJson(chatgptBase({}))).toThrow(/ChatGPTUpstreamState must be a plain object/);
  expect(() => upstreamRecordToFullJson(claudeCodeBase({}))).toThrow(/ClaudeCodeUpstreamState must be a plain object/);
});
