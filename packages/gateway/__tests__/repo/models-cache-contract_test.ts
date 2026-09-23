import { expect, test } from 'vitest';

import { MODEL_CATALOG_REVISION, shouldScheduleModelsRefresh } from '../../src/repo/models-cache-contract.ts';

test('automatic refresh becomes due ten minutes after the last successful catalog', () => {
  const cache = { revision: MODEL_CATALOG_REVISION, fetchedAt: 1_000, models: [], lastError: null };
  const dueAt = cache.fetchedAt + 10 * 60_000;

  expect(shouldScheduleModelsRefresh(cache, dueAt - 1)).toBe(false);
  expect(shouldScheduleModelsRefresh(cache, dueAt)).toBe(true);
  expect(shouldScheduleModelsRefresh({ ...cache, lastError: { message: 'failure', at: dueAt - 1, failureCount: 1 } }, dueAt - 1)).toBe(false);
  expect(shouldScheduleModelsRefresh({ ...cache, revision: MODEL_CATALOG_REVISION - 1 }, dueAt - 1)).toBe(true);
  expect(shouldScheduleModelsRefresh(null, dueAt - 1)).toBe(true);
});
