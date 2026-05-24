import { test } from 'vitest';

import { upstreamRecordToFullJson, upstreamRecordToJson } from './serialize.ts';
import type { UpstreamRecord } from '../../repo/types.ts';
import { assertEquals } from '../../test-assert.ts';

const timestamp = '2026-04-29T00:00:00.000Z';

const custom: UpstreamRecord = {
  id: 'up_custom_test',
  provider: 'custom',
  name: 'Custom Upstream',
  enabled: true,
  sortOrder: 10,
  createdAt: timestamp,
  updatedAt: timestamp,
  flagOverrides: { 'vendor-deepseek': true },
  config: {
    baseUrl: 'https://api.example.com',
    bearerToken: 'sk-secret-token-12345',
    supportedEndpoints: ['/chat/completions', '/responses'],
    pathOverrides: { models: '/models' },
  },
};

test('upstreamRecordToJson redacts custom bearer token inside config', () => {
  const result = upstreamRecordToJson(custom);
  const config = result.config as Record<string, unknown>;

  assertEquals(result.id, 'up_custom_test');
  assertEquals(result.provider, 'custom');
  assertEquals(result.sort_order, 10);
  assertEquals(result.created_at, timestamp);
  assertEquals(result.updated_at, timestamp);
  assertEquals(result.flag_overrides, { 'vendor-deepseek': true });
  assertEquals(config.baseUrl, 'https://api.example.com');
  assertEquals(config.bearerToken, undefined);
  assertEquals(config.bearerTokenSet, true);
  assertEquals(config.supportedEndpoints, ['/chat/completions', '/responses']);
  assertEquals(config.pathOverrides, { models: '/models' });
});

test('upstreamRecordToJson redacts Azure API keys inside config', () => {
  const result = upstreamRecordToJson({
    ...custom,
    id: 'up_azure_test',
    provider: 'azure',
    config: {
      endpoint: 'https://example.openai.azure.com',
      apiKey: 'az-secret',
      deployments: [{ deployment: 'gpt-prod', supportedEndpoints: ['/chat/completions'] }],
    },
  });
  const config = result.config as Record<string, unknown>;

  assertEquals(result.provider, 'azure');
  assertEquals(config.endpoint, 'https://example.openai.azure.com');
  assertEquals(config.apiKey, undefined);
  assertEquals(config.apiKeySet, true);
  assertEquals(config.deployments, [{ deployment: 'gpt-prod', supportedEndpoints: ['/chat/completions'] }]);
});

test('upstreamRecordToJson redacts Copilot GitHub token inside config', () => {
  const result = upstreamRecordToJson({
    ...custom,
    id: 'up_copilot_test',
    provider: 'copilot',
    config: {
      githubToken: 'ghu_secret',
      accountType: 'individual',
      user: {
        id: 100,
        login: 'octo',
        name: null,
        avatar_url: 'https://example.com/avatar.png',
      },
    },
  });
  const config = result.config as Record<string, unknown>;

  assertEquals(result.provider, 'copilot');
  assertEquals(config.githubToken, undefined);
  assertEquals(config.githubTokenSet, true);
  assertEquals(config.accountType, 'individual');
  assertEquals(config.user, {
    id: 100,
    login: 'octo',
    name: null,
    avatar_url: 'https://example.com/avatar.png',
  });
});

test('upstreamRecordToFullJson includes provider config secrets for export', () => {
  const result = upstreamRecordToFullJson(custom);
  const config = result.config as Record<string, unknown>;

  assertEquals(result.id, 'up_custom_test');
  assertEquals(config.bearerToken, 'sk-secret-token-12345');
  assertEquals(config.bearerTokenSet, undefined);
});
