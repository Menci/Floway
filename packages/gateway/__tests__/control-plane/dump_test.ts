import { expect, test, vi } from 'vitest';

import { initDumpStore } from '../../src/dump/registry.ts';
import type { DumpStore } from '../../src/dump/store-contract.ts';
import { dumpStoreStub } from '../dump/archive-fixtures.ts';
import { requestApp, setupAppTest } from '../test-utils/app.ts';

test('GET /api/dump/keys/:keyId/records requires an owned key with retention', async () => {
  const { apiKey } = await setupAppTest();
  const list = vi.fn(async () => []);
  initDumpStore(dumpStoreStub({ list }));
  const response = await requestApp(`/api/dump/keys/${apiKey.id}/records`, { headers: { 'x-api-key': apiKey.key } });
  expect(response.status).toBe(404);
  expect(list).not.toHaveBeenCalled();
});

test('GET /api/dump/keys/:keyId/records applies pagination and filter parameters', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: 3600 });
  const list = vi.fn<DumpStore['list']>(async () => []);
  initDumpStore(dumpStoreStub({ list }));

  const path = `/api/dump/keys/${apiKey.id}/records`;
  const request = { headers: { 'x-api-key': apiKey.key } };
  expect((await requestApp(path, request)).status).toBe(200);
  expect((await requestApp(`${path}?limit=2&q=model&failures=true&before=cursor`, request)).status).toBe(200);
  expect(list.mock.calls.map(([, options]) => options)).toMatchObject([
    { limit: 100, failures: false }, { limit: 2, failures: true, q: 'model', before: 'cursor' },
  ]);
});

test('serves the completed archive with its exact text', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: 3600 });
  const contents = '{"type":"object","fromObjectId":1,"nodes":[900719925474099312345]}\n';
  const get = vi.fn(async () => new Blob([contents]).stream());
  initDumpStore(dumpStoreStub({ get }));
  const response = await requestApp(`/api/dump/keys/${apiKey.id}/records/archive`, { headers: { 'x-api-key': apiKey.key } });
  expect(response.status).toBe(200);
  expect(response.headers.get('Content-Type')).toBe('application/x-ndjson; charset=utf-8');
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(await response.text()).toBe(contents);
  expect(get).toHaveBeenCalledWith(apiKey.id, 'archive');
});
