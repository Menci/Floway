import { expect, test, vi } from 'vitest';

import { initRepo } from './index.ts';
import { InMemoryRepo } from './memory.ts';
import { sweepResponsesState } from './responses-maintenance.ts';
import { responsesItemPayloadExpiryBucketPrefix } from './responses-payload.ts';
import { initFileProvider, MemoryFileProvider } from '@floway-dev/platform';

test('expiry janitor stops at its D1 mutation budget and advances only after an hour drains', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const files = new MemoryFileProvider();
  initFileProvider(files);
  const expiryHour = Date.UTC(2026, 0, 1, 10);
  await repo.responsesMaintenance.setNextExpiryHour(expiryHour);
  for (let index = 0; index < 2_000; index += 1) {
    await repo.responsesSnapshots.insert({
      id: `resp_${index}`,
      apiKeyId: 'key-a',
      stateEpoch: '11'.repeat(16),
      itemIds: [`msg_${index}`],
      refreshedAt: expiryHour - 1,
      expiresAt: expiryHour + 1,
    });
  }
  const orphanKey = `${responsesItemPayloadExpiryBucketPrefix(expiryHour)}orphan.gz`;
  await files.put(orphanKey, new Uint8Array([1]));
  const deleteSnapshots = vi.spyOn(repo.responsesSnapshots, 'deleteExpiredHour');

  await sweepResponsesState(expiryHour + 2 * 60 * 60 * 1000);

  expect(deleteSnapshots).toHaveBeenCalledTimes(20);
  expect(await repo.responsesMaintenance.getNextExpiryHour()).toBe(expiryHour);
  expect(await files.get(orphanKey)).not.toBeNull();

  await sweepResponsesState(expiryHour + 2 * 60 * 60 * 1000);

  expect(await repo.responsesMaintenance.getNextExpiryHour()).toBe(expiryHour + 2 * 60 * 60 * 1000);
  expect(await files.get(orphanKey)).toBeNull();
});
