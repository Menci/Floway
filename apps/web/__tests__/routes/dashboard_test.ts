import { afterEach, expect, test, vi } from 'vitest';

import { clientLoader, shouldRevalidate } from '../../src/routes/dashboard';
import { useAuthStore } from '../../src/stores/auth-store';
import { stubLocalStorage } from '../local-storage-stub';

stubLocalStorage();

afterEach(() => {
  useAuthStore.getState().clear();
  vi.unstubAllGlobals();
});

test('dashboard navigation refreshes capability fields from auth/me', async () => {
  useAuthStore.getState().primeFromLogin({
    token: 'session',
    user: { id: 2, username: 'alice', isAdmin: false, canViewPermissions: false, canViewUpstreams: false, preferences: { quotaDisplay: 'remaining' as const, language: null } },
  });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({
    user: { id: 2, username: 'alice', isAdmin: false, canViewPermissions: true, canViewUpstreams: true, preferences: { quotaDisplay: 'remaining' as const, language: null } },
    viaApiKey: false,
    apiKey: null,
  })));

  await clientLoader();
  expect(useAuthStore.getState().session?.user.canViewUpstreams).toBe(true);
});

test('dashboard auth refreshes on pathname navigation but not query-only navigation', () => {
  const check = (current: string, next: string) => shouldRevalidate({
    currentUrl: new URL(current),
    nextUrl: new URL(next),
    defaultShouldRevalidate: true,
  } as never);
  expect(check('http://localhost/dashboard?tab=a', 'http://localhost/dashboard?tab=b')).toBe(false);
  expect(check('http://localhost/dashboard', 'http://localhost/dashboard/services/api-keys')).toBe(true);
});
