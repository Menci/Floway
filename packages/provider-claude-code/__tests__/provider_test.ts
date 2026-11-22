import { beforeEach, describe, expect, test } from 'vitest';

import { createClaudeCodeProvider } from '../src/provider.ts';
import { initProviderRepo, type Fetcher, type UpstreamRecord } from '@floway-dev/provider';

const accessToken = {
  token: 'at_catalog',
  expiresAt: Date.now() + 24 * 60 * 60 * 1000,
  refreshedAt: new Date().toISOString(),
};

const record = (): UpstreamRecord => ({
  id: 'up_cc_provider',
  kind: 'claude-code',
  name: 'Claude Code',
  enabled: true,
  usageRefreshIntervalMinutes: 0,
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  config: {
    accounts: [{
      email: 'claude@example.com',
      accountUuid: 'acc-1',
      organizationUuid: null,
      subscriptionType: 'max',
      rateLimitTier: 'default_claude_max_5x',
    }],
  },
  state: {
    accounts: [{
      accountUuid: 'acc-1',
      tokenKind: 'oauth',
      refreshToken: 'rt_v1',
      state: 'active',
      stateUpdatedAt: '2026-01-01T00:00:00Z',
      accessToken,
      quotaSnapshot: null,
      usageProbeSnapshot: null,
    }],
  },
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  modelsCache: null,
  hue: 210,
});

beforeEach(() => {
  initProviderRepo(() => ({
    recordUpstreamMetric: async () => undefined,
    upstreams: {
      getById: async () => ({ ...record(), configVersion: 1 }),
      saveState: async () => undefined,
    },
  }));
});

describe('createClaudeCodeProvider', () => {
  test('catalog lookup reuses the cached token and exposes the dated model id', async () => {
    const fetcher: Fetcher = async (_url, init) => {
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer at_catalog');
      return Response.json({
        data: [{ id: 'claude-sonnet-4-5-20250929', display_name: 'Claude Sonnet 4.5', max_input_tokens: 1_000_000 }],
      });
    };
    const provider = createClaudeCodeProvider(record());
    const models = await provider.instance.getProvidedModels(fetcher);

    expect(models.map(model => model.id)).toContain('claude-sonnet-4-5');
    expect(models.find(model => model.id === 'claude-sonnet-4-5')).toMatchObject({
      providerData: { upstreamModelId: 'claude-sonnet-4-5-20250929' },
    });
    expect(provider.pipelines.anthropicMessages !== undefined).toBe(true);
  });
});
