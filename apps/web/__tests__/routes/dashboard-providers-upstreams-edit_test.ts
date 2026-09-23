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
  mocks.get.mockResolvedValue({ data: { id: 'up_saved', modelsCache: { fetchedAt: 100, lastError: null, modelCount: 2 } }, error: null });
  mocks.loadAux.mockResolvedValue({ proxies: [], backoffs: [], upstreams: [], runtime: { kind: 'node', runtimeLocation: 'TEST' } });
});

test('opening a saved upstream reads its record and cache status without fetching models', async () => {
  const loaded = await clientLoader({ params: { id: 'up_saved' } } as Parameters<typeof clientLoader>[0]);
  expect(loaded.record.modelsCache).toEqual({ fetchedAt: 100, lastError: null, modelCount: 2 });
  expect(loaded.discovered).toEqual([]);
  expect(loaded.modelsError).toBeNull();
  expect(mocks.get).toHaveBeenCalledTimes(1);
  expect(mocks.listModels).not.toHaveBeenCalled();
});
