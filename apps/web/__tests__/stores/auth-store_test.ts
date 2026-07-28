import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCurrentSession: vi.fn(),
  logout: vi.fn(),
}));

vi.mock('../../src/api/client', () => ({
  api: { auth: { logout: { $post: mocks.logout } } },
  getCurrentSession: mocks.getCurrentSession,
}));

import { setSessionToken } from '../../src/auth/session';
import { useAuthStore } from '../../src/stores/auth-store';

const oldUser = { id: 1, username: 'old', isAdmin: true, upstreamIds: null };
const newUser = { id: 2, username: 'new', isAdmin: true, upstreamIds: null };

describe('auth store request ownership', () => {
  beforeEach(() => {
    mocks.getCurrentSession.mockReset();
    mocks.logout.mockReset();
    useAuthStore.getState().clear();
  });

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
});
