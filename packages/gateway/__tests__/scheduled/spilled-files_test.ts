import { expect, test, vi } from 'vitest';

import { collectSpilledFiles } from '../../src/scheduled/spilled-files.ts';
import { setupAppTest } from '../test-utils/app.ts';
import { initFileStore, MemoryFileStore } from '@floway-dev/platform';

test('spilled-file collection leaves its claim unacknowledged when object deletion fails', async () => {
  const { repo } = await setupAppTest();
  vi.spyOn(repo.spilledFiles, 'claimCollectible').mockResolvedValue(['a', 'b']);
  const acknowledge = vi.spyOn(repo.spilledFiles, 'acknowledge');
  initFileStore({
    put: () => Promise.resolve(),
    get: () => Promise.resolve(null),
    deleteKeys: () => Promise.reject(new Error('object store unavailable')),
  });

  await expect(collectSpilledFiles(100)).rejects.toThrow('object store unavailable');

  expect(acknowledge).not.toHaveBeenCalled();
});

test('spilled-file collection rejects a partial acknowledgement after deleting the exact files', async () => {
  const { repo } = await setupAppTest();
  const files = new MemoryFileStore();
  initFileStore(files);
  await files.put('a', new Uint8Array([1]));
  await files.put('b', new Uint8Array([2]));
  vi.spyOn(repo.spilledFiles, 'claimCollectible').mockResolvedValue(['a', 'b']);
  vi.spyOn(repo.spilledFiles, 'acknowledge').mockResolvedValue(1);

  await expect(collectSpilledFiles(100)).rejects.toThrow(
    'Spilled-file collection acknowledged 1 of 2 claimed files',
  );

  expect(await files.get('a')).toBeNull();
  expect(await files.get('b')).toBeNull();
});

test('spilled-file collection performs no object-store or acknowledgement work for an empty claim', async () => {
  const { repo } = await setupAppTest();
  vi.spyOn(repo.spilledFiles, 'claimCollectible').mockResolvedValue([]);
  const acknowledge = vi.spyOn(repo.spilledFiles, 'acknowledge');
  const deleteKeys = vi.fn(() => Promise.resolve());
  initFileStore({
    put: () => Promise.resolve(),
    get: () => Promise.resolve(null),
    deleteKeys,
  });

  await expect(collectSpilledFiles(100)).resolves.toBeUndefined();

  expect(deleteKeys).not.toHaveBeenCalled();
  expect(acknowledge).not.toHaveBeenCalled();
});
