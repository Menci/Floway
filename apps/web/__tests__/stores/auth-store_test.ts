import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCurrentSession: vi.fn(),
  logout: vi.fn(),
}));

vi.mock('../../src/api/auth', () => ({
  getCurrentSession: mocks.getCurrentSession,
}));

// authFetch is the subject of the stale-401 case below, so the client module
// keeps its real implementation and only the logout route is stubbed.
vi.mock('../../src/api/client', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/api/client')>(),
  api: { auth: { logout: { $post: mocks.logout } } },
}));

import { authFetch } from '../../src/api/client';
import { getSessionToken, setSessionToken } from '../../src/auth/session';
import { useAuthStore } from '../../src/stores/auth-store';
import { stubLocalStorage } from '../local-storage-stub';

const oldUser = { id: 1, username: 'old', isAdmin: true, upstreamIds: null };
const newUser = { id: 2, username: 'new', isAdmin: true, upstreamIds: null };

describe('auth store request ownership', () => {
  stubLocalStorage();

  beforeEach(() => {
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

    useAuthStore.getState().primeFromLogin({ token: 'new-token', user: newUser });
    resolveRequest({ data: { user: oldUser, viaApiKey: false, apiKey: null } });
    await pending;

    expect(useAuthStore.getState().session).toEqual({ token: 'new-token', user: newUser });
  });

  it('keeps the authenticated identity when a forced refresh fails transiently', async () => {
    useAuthStore.getState().primeFromLogin({ token: 'current-token', user: newUser });
    mocks.getCurrentSession.mockResolvedValue({ error: { status: 503, message: 'Unavailable' } });

    await useAuthStore.getState().refresh();

    expect(useAuthStore.getState().session?.user).toEqual(newUser);
    expect(useAuthStore.getState().error).toEqual({ status: 503, message: 'Unavailable' });
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
