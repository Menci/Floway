import { beforeEach, expect, test } from 'vitest';

import { resolveLegacyOpaqueBlobCompatibilityIdentity } from '../../../../../src/data-plane/chat/shared/affinity/legacy.ts';
import { initRepo } from '../../../../../src/repo/index.ts';
import { MODEL_CATALOG_REVISION } from '../../../../../src/repo/models-cache-contract.ts';
import { InMemoryRepo } from '../../../../repo/memory.ts';
import { seedModelsCache } from '../../../../repo/models-cache-fixture.ts';
import { saveUpstreamForTest } from '../../../../repo/upstreams.ts';
import { stubUpstreamModel } from '@floway-dev/test-utils';
import type { UpstreamRecord } from '@floway-dev/upstream';

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
  usageRefreshIntervalMinutes: 0,
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  hue: 210,
  config: {
    baseUrl: 'https://example.com',
    endpoints: { openaiResponses: {} },
    ingressHeadersRules: [],
    modelsFetch: { enabled: true, authStyle: 'bearer' },
  },
  state: null,
  ...overrides,
} as UpstreamRecord);

test('resolves v1 affinity from the current provider-model cache for bound and unbound scopes', async () => {
  const record = upstream();
  await saveUpstreamForTest(repo.upstreams, record);
  const stored = (await repo.upstreams.getById(record.id))!;
  await seedModelsCache(repo.upstreams, record.id, {
    version: stored.version,
    revision: MODEL_CATALOG_REVISION,
    fetchedAt: Date.now(),
    models: [
      stubUpstreamModel({
        id: 'gpt-main',
        upstreamModelId: 'gpt-main-wire',
        opaqueBlobCompatibilityScope: { bindToUpstream: true, key: 'openai' },
      }),
      stubUpstreamModel({
        id: 'claude-public',
        upstreamModelId: 'claude-wire',
        opaqueBlobCompatibilityScope: { bindToUpstream: false, key: 'claude-opus' },
      }),
    ],
  });

  await expect(resolveLegacyOpaqueBlobCompatibilityIdentity({ upstreamId: 'up-a', modelId: 'gpt-main' }))
    .resolves.toEqual({ upstreamId: 'up-a', key: 'openai' });
  await expect(resolveLegacyOpaqueBlobCompatibilityIdentity({ upstreamId: 'up-a', modelId: 'claude-public' }))
    .resolves.toEqual({ key: 'claude-opus' });
});
