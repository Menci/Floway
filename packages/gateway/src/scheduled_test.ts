import { test, vi } from 'vitest';

import { initDumpBroker, initDumpStore } from './dump/registry.ts';
import { installDumpStubs } from './dump/test-fixtures.ts';
import { runScheduledDumpMaintenance, runScheduledMaintenance } from './scheduled.ts';
import { setupAppTest } from './test-helpers.ts';
import { initFileProvider, initImageCacheStore, MemoryFileProvider } from '@floway-dev/platform';
import { assertEquals } from '@floway-dev/test-utils';

const noopImageCache = {
  get: async () => null,
  put: async () => { /* noop */ },
  sweepExpired: async () => { /* noop */ },
};

test('dump maintenance processes one backfill and at most four cleanup units per invocation', async () => {
  await setupAppTest();
  const stubs = installDumpStubs(initDumpStore, initDumpBroker);
  const backfill = vi.spyOn(stubs.store, 'backfillMaintenanceBatch').mockResolvedValue(true);
  const purge = vi.spyOn(stubs.store, 'purgeNextMaintenanceBatch').mockResolvedValue(true);

  await runScheduledDumpMaintenance();

  assertEquals(backfill.mock.calls.length, 1);
  assertEquals(purge.mock.calls.length, 4);
});

test('runScheduledMaintenance keeps subsequent sweeps running when one top-level sweep throws', async () => {
  const { repo, apiKey: keyA } = await setupAppTest();
  await repo.apiKeys.save({ ...keyA, dumpRetentionSeconds: 3600 });

  initImageCacheStore({
    ...noopImageCache,
    sweepExpired: async () => { throw new Error('image cache exploded'); },
  });
  const stubs = installDumpStubs(initDumpStore, initDumpBroker);
  const purge = vi.spyOn(stubs.store, 'purgeNextMaintenanceBatch').mockResolvedValueOnce(true).mockResolvedValue(false);

  await runScheduledMaintenance();
  assertEquals(purge.mock.calls.length, 2);
});

test('state-maintenance failure keeps spilled payloads while dump maintenance remains independent', async () => {
  const { repo } = await setupAppTest();
  const files = new MemoryFileProvider();
  const imageSweep = vi.fn(async () => {});
  initFileProvider(files);
  initImageCacheStore({ ...noopImageCache, sweepExpired: imageSweep });
  const dumps = installDumpStubs(initDumpStore, initDumpBroker);
  const dumpSweep = vi.spyOn(dumps.store, 'purgeNextMaintenanceBatch').mockResolvedValue(false);
  const key = 'responses-items/v1/expires/2000/01/01/00/key/item/payload.gz';
  await files.put(key, new Uint8Array([1]));
  vi.spyOn(repo.responsesMaintenance, 'claimStateSweep').mockResolvedValue({
    apiKeyId: 'key-a',
    revision: 0,
    stateEpoch: null,
    retentionSeconds: 0,
  });
  const deletion = vi.spyOn(repo.responsesItems, 'deleteReclaimable').mockRejectedValue(new Error('item deletion failed'));
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await runScheduledMaintenance();
  } finally {
    deletion.mockRestore();
    error.mockRestore();
  }

  assertEquals(await files.get(key), new Uint8Array([1]));
  assertEquals(imageSweep.mock.calls.length, 0);
  assertEquals(dumpSweep.mock.calls.length, 1);
});
