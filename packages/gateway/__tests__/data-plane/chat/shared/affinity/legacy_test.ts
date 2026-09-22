import { beforeEach, expect, test } from 'vitest';

import { resolveLegacyOpaqueBlobCompatibilityIdentity } from '../../../../../src/data-plane/chat/shared/affinity/legacy.ts';
import { initRepo } from '../../../../../src/repo/index.ts';
import { MODEL_CATALOG_REVISION } from '../../../../../src/repo/models-cache-contract.ts';
import { InMemoryRepo } from '../../../../repo/memory.ts';
import type { UpstreamRecord } from '@floway-dev/provider';
import { stubProviderModel } from '@floway-dev/test-utils';

const repo = new InMemoryRepo();

beforeEach(async () => {
  initRepo(repo);
  await repo.upstreams.deleteAll();
});

const upstream = (overrides: Partial<UpstreamRecord> = {}): UpstreamRecord => ({
  id: 'up-a',
  kind: 'custom',
  name: 'Custom',
  enabled: true,
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  modelsCache: null,
  hue: 210,
  config: {
    baseUrl: 'https://example.com',
    authStyle: 'bearer',
    endpoints: { openaiResponses: {} },
    ingressHeadersRules: [],
    modelsFetch: { enabled: true },
    models: [],
  },
  state: null,
  ...overrides,
} as UpstreamRecord);

test('resolves v1 affinity from the current provider-model cache', async () => {
  const record = upstream();
  await repo.upstreams.save(record);
  await repo.upstreams.saveModelsCache(record.id, { updatedAt: record.updatedAt, config: record.config }, {
    revision: MODEL_CATALOG_REVISION,
    fetchedAt: Date.now(),
    models: [stubProviderModel({
      id: 'gpt-main',
      upstreamModelId: 'gpt-main-wire',
      opaqueBlobCompatibilityScope: { bindToUpstream: true, key: 'openai' },
    })],
  });

  await expect(resolveLegacyOpaqueBlobCompatibilityIdentity({ upstreamId: 'up-a', modelId: 'gpt-main' }))
    .resolves.toEqual({ upstreamId: 'up-a', key: 'openai' });
});

test('resolves v1 affinity from manual configuration when the catalog is cold', async () => {
  await repo.upstreams.save(upstream({
    config: {
      baseUrl: 'https://example.com',
      authStyle: 'bearer',
      endpoints: { openaiResponses: {} },
      ingressHeadersRules: [],
      modelsFetch: { enabled: false },
      models: [{
        upstreamModelId: 'claude-wire',
        publicModelId: 'claude-public',
        kind: 'chat',
        endpoints: { openaiResponses: {} },
        opaqueBlobCompatibilityScope: { bindToUpstream: false, key: 'claude-opus' },
      }],
    },
  }));

  await expect(resolveLegacyOpaqueBlobCompatibilityIdentity({ upstreamId: 'up-a', modelId: 'claude-public' }))
    .resolves.toEqual({ key: 'claude-opus' });
});
