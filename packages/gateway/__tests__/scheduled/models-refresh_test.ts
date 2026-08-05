import { expect, test, vi } from 'vitest';

import { initRepo } from '../../src/repo/index.ts';
import { MODEL_CATALOG_REVISION } from '../../src/repo/models-cache-contract.ts';
import { refreshModelsCaches } from '../../src/scheduled/models-refresh.ts';
import { InMemoryRepo } from '../repo/memory.ts';
import type { UpstreamRecord } from '@floway-dev/provider';
import { withMockedFetch } from '@floway-dev/test-utils';

const custom = (id: string, enabled: boolean): UpstreamRecord => ({
  id,
  kind: 'custom',
  name: id,
  enabled,
  sortOrder: 0,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  config: {
    baseUrl: `https://${id}.example.com`,
    authStyle: 'bearer',
    apiKey: 'key',
    endpoints: { chatCompletions: {} },
    ingressHeadersRules: [],
  },
  state: null,
  modelsCache: null,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [{ id: 'direct_fetch' }],
  modelPrefix: null,
  hue: 210,
});

test('scheduled maintenance submits enabled refreshes without waiting for model I/O', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  await repo.upstreams.save(custom('enabled', true));
  await repo.upstreams.save(custom('disabled', false));
  let resolveFetch: ((response: Response) => void) | null = null;
  const requested: string[] = [];

  await withMockedFetch(
    request => {
      requested.push(new URL(request.url).hostname);
      return new Promise<Response>(resolve => { resolveFetch = resolve; });
    },
    async () => {
      const background: Promise<unknown>[] = [];
      await refreshModelsCaches('SCHEDULED', promise => { background.push(promise); });

      expect(background).toHaveLength(1);
      await vi.waitFor(() => expect(requested).toEqual(['enabled.example.com']));
      expect((await repo.upstreams.getById('enabled'))?.modelsCache).toBeNull();

      resolveFetch!(Response.json({ data: [{ id: 'enabled-public' }] }));
      await background[0];
      expect((await repo.upstreams.getById('enabled'))?.modelsCache).toMatchObject({
        revision: MODEL_CATALOG_REVISION,
        models: [{ id: 'enabled-public' }],
      });
      expect((await repo.upstreams.getById('disabled'))?.modelsCache).toBeNull();
    },
  );
});
