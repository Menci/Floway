import { expect, test } from 'vitest';

import { isModelsCacheDue, MODEL_CATALOG_REVISION } from '../../src/repo/models-cache-contract.ts';

test('automatic refresh becomes due ten minutes after the last successful catalog for network upstreams', () => {
  const cache = { revision: MODEL_CATALOG_REVISION, fetchedAt: 1_000, lastError: null };
  const dueAt = cache.fetchedAt + 10 * 60_000;

  expect(isModelsCacheDue(cache, dueAt - 1, true)).toBe(false);
  expect(isModelsCacheDue(cache, dueAt, true)).toBe(true);
  expect(isModelsCacheDue({ ...cache, revision: MODEL_CATALOG_REVISION - 1 }, dueAt - 1, true)).toBe(true);
  expect(isModelsCacheDue({ revision: null, fetchedAt: null, lastError: null }, dueAt - 1, true)).toBe(true);
});

test('local-only upstreams are due only when cold or behind the current revision', () => {
  const cache = { revision: MODEL_CATALOG_REVISION, fetchedAt: 1_000, lastError: null };
  const wayLater = cache.fetchedAt + 24 * 60 * 60_000;

  expect(isModelsCacheDue(cache, wayLater, false)).toBe(false);
  expect(isModelsCacheDue({ ...cache, revision: MODEL_CATALOG_REVISION - 1 }, 1_000, false)).toBe(true);
  expect(isModelsCacheDue({ revision: null, fetchedAt: null, lastError: null }, 1_000, false)).toBe(true);
});
