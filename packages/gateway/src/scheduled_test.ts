import { test, vi } from 'vitest';

import { initDumpBroker, initDumpStore } from './dump/registry.ts';
import { installDumpStubs } from './dump/test-fixtures.ts';
import { runScheduledMaintenance } from './scheduled.ts';
import { setupAppTest } from './test-helpers.ts';
import { initFileProvider, initImageCacheStore, MemoryFileProvider } from '@floway-dev/platform';
import { assertEquals } from '@floway-dev/test-utils';

const noopImageCache = {
  get: async () => null,
  put: async () => { /* noop */ },
  sweepExpired: async () => { /* noop */ },
};

test('runScheduledMaintenance continues sweeping the next key when one key throws', async () => {
  const { repo, apiKey: keyA } = await setupAppTest();
  await repo.apiKeys.save({ ...keyA, dumpRetentionSeconds: 3600 });
  const keyB = {
    ...keyA,
    id: `${keyA.id}_sibling`,
    key: `${keyA.key}_sibling`,
    dumpRetentionSeconds: 1800,
  };
  await repo.apiKeys.save(keyB);

  initImageCacheStore(noopImageCache);
  const stubs = installDumpStubs(initDumpStore, initDumpBroker);
  stubs.failOn('purgeExpired', new Error('purge exploded'));

  const errors: unknown[][] = [];
  const origError = console.error;
  console.error = (...args: unknown[]): void => { errors.push(args); };
  try {
    await runScheduledMaintenance();
  } finally {
    console.error = origError;
  }

  assertEquals(stubs.purgedExpired.some(c => c.keyId === keyA.id), true);
  assertEquals(stubs.purgedExpired.some(c => c.keyId === keyB.id), true);
  assertEquals(
    errors.some(args => args[0] === '[scheduled] dump sweep failed' && args[1] === keyA.id),
    true,
  );
  assertEquals(
    errors.some(args => args[0] === '[scheduled] dump sweep failed' && args[1] === keyB.id),
    true,
  );
});

test('runScheduledMaintenance keeps subsequent sweeps running when one top-level sweep throws', async () => {
  const { repo, apiKey: keyA } = await setupAppTest();
  await repo.apiKeys.save({ ...keyA, dumpRetentionSeconds: 3600 });

  initImageCacheStore({
    ...noopImageCache,
    sweepExpired: async () => { throw new Error('image cache exploded'); },
  });
  const stubs = installDumpStubs(initDumpStore, initDumpBroker);

  await runScheduledMaintenance();
  assertEquals(stubs.purgedExpired.some(c => c.keyId === keyA.id), true);
});

test('runScheduledMaintenance keeps spilled payloads when item-row deletion fails', async () => {
  const { repo } = await setupAppTest();
  const files = new MemoryFileProvider();
  initFileProvider(files);
  initImageCacheStore(noopImageCache);
  installDumpStubs(initDumpStore, initDumpBroker);
  const key = 'responses-items/v1/expires/2000/01/01/00/key/item/payload.gz';
  await files.put(key, new Uint8Array([1]));
  const deletion = vi.spyOn(repo.responsesItems, 'deleteOlderThan').mockRejectedValue(new Error('item deletion failed'));
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await runScheduledMaintenance();
  } finally {
    deletion.mockRestore();
    error.mockRestore();
  }

  assertEquals(await files.get(key), new Uint8Array([1]));
});
