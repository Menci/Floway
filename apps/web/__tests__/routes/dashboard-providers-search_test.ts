import { afterEach, describe, expect, it, vi } from 'vitest';

import { setSessionToken } from '../../src/auth/session';
import { clientLoader } from '../../src/routes/dashboard-providers-search';
import { useAuthStore } from '../../src/stores/auth-store';
import { stubLocalStorage } from '../local-storage-stub';

stubLocalStorage();

afterEach(() => {
  useAuthStore.getState().clear();
  vi.unstubAllGlobals();
});

describe('who search settings open for', () => {
  it('redirects an operator away before calling an admin endpoint', async () => {
    const user = { id: 2, username: 'operator', isAdmin: false, upstreamIds: null };
    setSessionToken('operator-session');
    useAuthStore.getState().primeFromLogin({ token: 'operator-session', user });
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    const thrown = await clientLoader().then(() => null, (caught: unknown) => caught);
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(302);
    expect((thrown as Response).headers.get('location')).toBe('/dashboard/services/api-keys');
    expect(fetch).not.toHaveBeenCalled();
  });
});
