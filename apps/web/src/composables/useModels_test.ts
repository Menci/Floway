import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { useRawModelsStore } from './useModels.ts';
import { useAuthStore } from '../stores/auth.ts';

const authenticate = (token: string, id: number) => {
  useAuthStore().setAuth({
    token,
    user: {
      id,
      username: `user-${id}`,
      isAdmin: id === 1,
      upstreamIds: null,
    },
  });
};

beforeEach(() => {
  setActivePinia(createPinia());
  useAuthStore().clearAuth();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test('concurrent model loads share one in-flight API request', async () => {
  authenticate('session-a', 1);
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

test('changing auth principal clears the previous catalog before a failed reload', async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(Response.json({ object: 'list', data: [{ id: 'admin-only' }] }))
    .mockResolvedValueOnce(Response.json({ error: 'catalog unavailable' }, { status: 502 }));
  vi.stubGlobal('fetch', fetchMock);

  authenticate('session-admin', 1);
  const store = useRawModelsStore();
  await store.load();
  expect(store.models.value).toEqual([{ id: 'admin-only' }]);

  authenticate('session-user', 2);
  expect(store.models.value).toBeNull();
  await store.load();

  expect(store.models.value).toBeNull();
  expect(store.error.value).toBe('catalog unavailable');
});

test('a previous principal in flight cannot overwrite the current catalog', async () => {
  let resolveAdmin: ((response: Response) => void) | undefined;
  const adminResponse = new Promise<Response>(resolve => { resolveAdmin = resolve; });
  const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    const token = new Headers(init?.headers).get('x-floway-session');
    if (token === 'session-admin') return adminResponse;
    if (token === 'session-user') return Promise.resolve(Response.json({ object: 'list', data: [{ id: 'user-model' }] }));
    throw new Error(`Unexpected auth principal: ${token}`);
  });
  vi.stubGlobal('fetch', fetchMock);

  authenticate('session-admin', 1);
  const store = useRawModelsStore();
  const adminLoad = store.load();

  authenticate('session-user', 2);
  const userLoad = store.load();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  await userLoad;
  expect(store.models.value).toEqual([{ id: 'user-model' }]);

  resolveAdmin?.(Response.json({ object: 'list', data: [{ id: 'admin-only' }] }));
  await adminLoad;
  expect(store.models.value).toEqual([{ id: 'user-model' }]);
  expect(store.error.value).toBeNull();
});
