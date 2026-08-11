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

test('scheduled maintenance lease keeps overlapping ticks within one budget', async () => {
  const { repo } = await setupAppTest();
  initFileStore(new MemoryFileStore());
  initImageCacheStore({ async get() { return null; }, async put() {}, async sweepExpired() {} });
  let enterClaim!: () => void;
  let finishClaim!: () => void;
  const claimEntered = new Promise<void>(resolve => { enterClaim = resolve; });
  const claimFinished = new Promise<void>(resolve => { finishClaim = resolve; });
  const claim = vi.spyOn(repo.expirationSweeps, 'claim').mockImplementation(async () => {
    enterClaim();
    await claimFinished;
    return null;
  });
  const collect = vi.spyOn(repo.spilledFiles, 'claimCollectible').mockResolvedValue([]);

  const first = runScheduledMaintenance();
  await claimEntered;
  await runScheduledMaintenance();
  finishClaim();
  await first;

  expect(claim).toHaveBeenCalledTimes(1);
  expect(collect).toHaveBeenCalledTimes(1);
});
