import { expect, test } from 'vitest';

import { initRepo } from '../../src/repo/index.ts';
import { MODEL_CATALOG_REVISION } from '../../src/repo/models-cache-contract.ts';
import { refreshModelsCaches } from '../../src/scheduled/models-refresh.ts';
import { InMemoryRepo } from '../repo/memory.ts';
import type { UpstreamRecord } from '@floway-dev/provider';

const azure = (id: string, enabled: boolean): UpstreamRecord => ({
  id,
  kind: 'azure',
  name: id,
  enabled,
  sortOrder: 0,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  config: {
    endpoint: 'https://example.openai.azure.com/openai/v1',
    apiKey: 'azkey',
    models: [{ upstreamModelId: `${id}-wire`, publicModelId: `${id}-public`, endpoints: { chatCompletions: {} } }],
  },
  state: null,
  modelsCache: null,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  hue: 210,
});

test('scheduled maintenance triggers cold enabled upstreams and waits for their background work', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  await repo.upstreams.save(azure('enabled', true));
  await repo.upstreams.save(azure('disabled', false));

  await refreshModelsCaches('SCHEDULED');

  const enabled = await repo.upstreams.getById('enabled');
  expect(enabled?.modelsCache?.revision).toBe(MODEL_CATALOG_REVISION);
  expect(enabled?.modelsCache?.models.map(model => model.id)).toEqual(['enabled-public']);
  expect((await repo.upstreams.getById('disabled'))?.modelsCache).toBeNull();
});
