import { expect, test, vi } from 'vitest';

import { clientLoader } from '../../src/routes/dashboard-providers-upstreams-copy';
import { kimiCodeRecord } from '../components/upstreams/kimi-code-fixture';

const mocks = vi.hoisted(() => ({ get: vi.fn(), list: vi.fn(), loadAux: vi.fn() }));
vi.mock('../../src/routes/guards', () => ({ requireDashboardAdmin: vi.fn() }));
vi.mock('../../src/api/client', () => ({
  api: { api: { upstreams: { ':id': { $get: mocks.get }, $get: mocks.list } } },
  callApi: (operation: () => unknown) => operation(),
}));
vi.mock('../../src/components/upstream-editor/data', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/components/upstream-editor/data')>(),
  loadEditorAux: mocks.loadAux,
}));

test('copies Kimi Code connection settings and clears account and quota readings', async () => {
  const source = kimiCodeRecord();
  mocks.get.mockResolvedValue({ data: source, error: null });
  mocks.list.mockResolvedValue({ data: [source], error: null });
  mocks.loadAux.mockResolvedValue({ proxies: [], runtime: { kind: 'node', runtimeLocation: 'TEST' } });
  const loaded = await clientLoader({ params: { id: source.id } } as Parameters<typeof clientLoader>[0]);
  expect(loaded.record).toMatchObject({ id: '', kind: 'kimi-code', config: source.config, state: null });
  expect(loaded.record.config).not.toBe(source.config);
  expect(loaded.record.hue).not.toBe(source.hue);
  expect(loaded.record.usage_refresh_interval_minutes).toBe(0);
});
