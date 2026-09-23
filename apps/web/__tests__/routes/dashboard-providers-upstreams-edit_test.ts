import { beforeEach, expect, test, vi } from 'vitest';

import { CATALOG_HANDOFF_QUERY, stageCatalogHandoff } from '../../src/components/upstream-editor/catalog-handoff';
import { clientLoader } from '../../src/routes/dashboard-providers-upstreams-edit';

const mocks = vi.hoisted(() => ({ get: vi.fn(), loadInitial: vi.fn(), loadAux: vi.fn() }));

vi.mock('../../src/routes/guards', () => ({ requireDashboardAdmin: vi.fn() }));
vi.mock('../../src/api/client', () => ({
  api: { api: { upstreams: { ':id': { $get: mocks.get } } } },
  callApi: (operation: () => unknown) => operation(),
}));
vi.mock('../../src/components/upstream-editor/data', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/components/upstream-editor/data')>(),
  loadEditorAux: mocks.loadAux,
  loadInitialModelCatalog: mocks.loadInitial,
}));

const load = (search = '') => clientLoader({
  params: { id: 'up_created' },
  request: new Request(`https://example.com/dashboard/providers/upstreams/up_created${search}`),
} as Parameters<typeof clientLoader>[0]);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue({ data: { id: 'up_created', configVersion: 2 }, error: null });
  mocks.loadAux.mockResolvedValue({ proxies: [], backoffs: [], upstreams: [], runtime: { kind: 'node', runtimeLocation: 'TEST' } });
  mocks.loadInitial.mockResolvedValue({ discovered: [{ upstreamModelId: 'live' }], modelsError: null, record: { id: 'up_created' } });
});

test('a matching create-save handoff uses the warm outcome without another fetch', async () => {
  const catalog = { discovered: [{ upstreamModelId: 'warmed', kind: 'chat' as const, endpoints: { openaiChatCompletions: {} } }], modelsError: null, modelsCache: null };
  const token = stageCatalogHandoff({ upstreamId: 'up_created', configVersion: 2, catalog });
  const loaded = await load(`?${CATALOG_HANDOFF_QUERY}=${token}`);
  expect(loaded.discovered).toEqual(catalog.discovered);
  expect(mocks.loadInitial).not.toHaveBeenCalled();

  await load(`?${CATALOG_HANDOFF_QUERY}=${token}`);
  expect(mocks.loadInitial).toHaveBeenCalledTimes(1);
});

test('a changed config version invalidates the create-save handoff', async () => {
  const token = stageCatalogHandoff({ upstreamId: 'up_created', configVersion: 1, catalog: { discovered: [], modelsError: null, modelsCache: null } });
  const loaded = await load(`?${CATALOG_HANDOFF_QUERY}=${token}`);
  expect(loaded.discovered).toEqual([{ upstreamModelId: 'live' }]);
  expect(mocks.loadInitial).toHaveBeenCalledTimes(1);
});
