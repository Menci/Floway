import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { useRawModelsStore } from './useModels.ts';

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test('concurrent model loads share one in-flight API request', async () => {
  let resolveFetch: ((response: Response) => void) | undefined;
  const response = new Promise<Response>(resolve => { resolveFetch = resolve; });
  const fetchMock = vi.fn(() => response);
  vi.stubGlobal('fetch', fetchMock);

  const store = useRawModelsStore();
  const first = store.load();
  const second = store.load();

  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(store.loading.value).toBe(true);
  resolveFetch?.(Response.json({ object: 'list', data: [] }));
  await Promise.all([first, second]);

  expect(store.loading.value).toBe(false);
  expect(store.error.value).toBeNull();
  expect(store.models.value).toEqual([]);
});
