import { expect, test, vi } from 'vitest';

import { runScheduledMaintenance } from '../src/scheduled.ts';
import { setupAppTest } from './test-utils/app.ts';
import { initFileStore, initImageCacheStore, MemoryFileStore } from '@floway-dev/platform';

test('scheduled maintenance isolates the shared expiration driver from later collectors', async () => {
  const { repo } = await setupAppTest();
  initFileStore(new MemoryFileStore());
  let imageSwept = false;
  initImageCacheStore({
    async get() { return null; },
    async put() {},
    async sweepExpired() { imageSwept = true; },
  });
  vi.spyOn(repo.expirationSweeps, 'claim').mockRejectedValue(new Error('expiration queue failed'));
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});

  try {
    await runScheduledMaintenance();
  } finally {
    error.mockRestore();
  }

  expect(imageSwept).toBe(true);
});

test('scheduled maintenance collects exact spilled files after expiration work', async () => {
  const { repo } = await setupAppTest();
  const files = new MemoryFileStore();
  initFileStore(files);
  initImageCacheStore({ async get() { return null; }, async put() {}, async sweepExpired() {} });
  vi.spyOn(repo.expirationSweeps, 'claim').mockResolvedValue(null);
  const key = 'spilled/retired.gz';
  await files.put(key, new Uint8Array([1]));
  vi.spyOn(repo.spilledFiles, 'claimCollectible').mockResolvedValue([key]);
  vi.spyOn(repo.spilledFiles, 'acknowledge').mockResolvedValue(1);

  await runScheduledMaintenance();

  expect(await files.get(key)).toBeNull();
});
