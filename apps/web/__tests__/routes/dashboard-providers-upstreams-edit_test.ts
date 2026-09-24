import { beforeEach, expect, test, vi } from 'vitest';

import { clientLoader } from '../../src/routes/dashboard-providers-upstreams-edit';

const mocks = vi.hoisted(() => ({ get: vi.fn(), listModels: vi.fn(), loadAux: vi.fn() }));

vi.mock('../../src/routes/guards', () => ({ requireDashboardAdmin: vi.fn() }));
vi.mock('../../src/api/client', () => ({
  api: { api: { upstreams: { ':id': { $get: mocks.get, 'list-models': { $post: mocks.listModels } } } } },
  callApi: (operation: () => unknown) => operation(),
}));
vi.mock('../../src/components/upstream-editor/data', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/components/upstream-editor/data')>(),
  loadEditorAux: mocks.loadAux,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue({
    data: {
      id: 'up_saved',
      modelsCache: { fetchedAt: 100, lastError: null, modelCount: 2 },
      cachedModels: [{ upstreamModelId: 'cached-model', publicModelId: 'cached-model', kind: 'chat', endpoints: { openaiResponses: {} } }],
    }, error: null,
  });
  mocks.loadAux.mockResolvedValue({ proxies: [], runtime: { kind: 'node', runtimeLocation: 'TEST' } });
});

test('opening a saved upstream reads cached model rows without fetching models', async () => {
  const loaded = await clientLoader({ params: { id: 'up_saved' } } as Parameters<typeof clientLoader>[0]);
  expect(loaded.record.modelsCache).toEqual({ fetchedAt: 100, lastError: null, modelCount: 2 });
  expect(loaded.discovered?.map(model => model.upstreamModelId)).toEqual(['cached-model']);
  expect(mocks.get).toHaveBeenCalledTimes(1);
  expect(mocks.listModels).not.toHaveBeenCalled();
});

test('opening an upstream without a successful cache keeps discovery unavailable', async () => {
  mocks.get.mockResolvedValue({
    data: {
      id: 'up_saved',
      modelsCache: { fetchedAt: null, lastError: null, modelCount: null },
      cachedModels: null,
    }, error: null,
  });
  const loaded = await clientLoader({ params: { id: 'up_saved' } } as Parameters<typeof clientLoader>[0]);
  expect(loaded.discovered).toBeNull();
  expect(mocks.listModels).not.toHaveBeenCalled();
});

test('a successful empty cache remains available without a refresh', async () => {
  mocks.get.mockResolvedValue({
    data: {
      id: 'up_saved',
      modelsCache: { fetchedAt: 100, lastError: null, modelCount: 0 },
      cachedModels: [],
    }, error: null,
  });
  const loaded = await clientLoader({ params: { id: 'up_saved' } } as Parameters<typeof clientLoader>[0]);
  expect(loaded.discovered).toEqual([]);
  expect(mocks.listModels).not.toHaveBeenCalled();
});
