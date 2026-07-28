import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCurrentSession: vi.fn(),
  logout: vi.fn(),
}));

vi.mock('../../src/api/client', () => ({
  api: { auth: { logout: { $post: mocks.logout } } },
  getCurrentSession: mocks.getCurrentSession,
}));

import { authFetch } from '../../src/api/auth';
import { getSessionToken, setSessionToken } from '../../src/auth/session';
import { useAuthStore } from '../../src/stores/auth-store';

const oldUser = { id: 1, username: 'old', isAdmin: true, upstreamIds: null };
const newUser = { id: 2, username: 'new', isAdmin: true, upstreamIds: null };
const originalLocalStorage = Object.getOwnPropertyDescriptor(window, 'localStorage');
const storage = new Map<string, string>();

describe('auth store request ownership', () => {
  beforeAll(() => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        clear: () => { storage.clear(); },
        getItem: (key: string) => storage.get(key) ?? null,
        key: (index: number) => [...storage.keys()][index] ?? null,
        get length() { return storage.size; },
        removeItem: (key: string) => { storage.delete(key); },
        setItem: (key: string, value: string) => { storage.set(key, value); },
      } satisfies Storage,
    });
  });

  afterAll(() => {
    if (originalLocalStorage) Object.defineProperty(window, 'localStorage', originalLocalStorage);
  });

  beforeEach(() => {
    storage.clear();
    mocks.getCurrentSession.mockReset();
    mocks.logout.mockReset();
    useAuthStore.getState().clear();
  });

  afterEach(() => vi.unstubAllGlobals());

  it('ignores a session response superseded by a newer login', async () => {
    let resolveRequest!: (value: unknown) => void;
    mocks.getCurrentSession.mockReturnValue(new Promise(resolve => {
      resolveRequest = resolve;
    }));
    setSessionToken('old-token');
    const pending = useAuthStore.getState().initialize();

    setSessionToken('new-token');
    useAuthStore.getState().primeFromLogin({ token: 'new-token', user: newUser });
    resolveRequest({ data: { user: oldUser, viaApiKey: false, apiKey: null } });
    await pending;

    expect(useAuthStore.getState().user).toEqual(newUser);
    expect(useAuthStore.getState().token).toBe('new-token');
  });

  it('keeps the authenticated identity when a forced refresh fails transiently', async () => {
    setSessionToken('current-token');
    useAuthStore.getState().primeFromLogin({ token: 'current-token', user: newUser });
    mocks.getCurrentSession.mockResolvedValue({ error: { status: 503, message: 'Unavailable' } });

    await useAuthStore.getState().refresh();

    expect(useAuthStore.getState().status).toBe('authenticated');
    expect(useAuthStore.getState().user).toEqual(newUser);
    expect(useAuthStore.getState().error).toBe('Unavailable');
  });

  it('does not let a stale 401 clear a newer token', async () => {
    let resolveFetch!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => {
      resolveFetch = resolve;
    })));
    setSessionToken('old-token');
    const pending = authFetch('/auth/me');

    setSessionToken('new-token');
    resolveFetch(new Response(null, { status: 401 }));
    await pending;

    expect(getSessionToken()).toBe('new-token');
  });
});
