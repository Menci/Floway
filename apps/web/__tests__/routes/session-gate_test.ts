import type { RouteConfigEntry } from '@react-router/dev/routes';
import { beforeEach, describe, expect, it } from 'vitest';

import routeConfig from '../../src/routes';
import { requireDashboardAdmin, requireDashboardSession, requireDashboardUser } from '../../src/routes/guards';
import { useAuthStore } from '../../src/stores/auth-store';
import { stubLocalStorage } from '../local-storage-stub';

// Read as text rather than imported: what is asserted is the module's shape,
// and importing a route would pull the whole component tree in with it.
const routeSources = import.meta.glob<string>('../../src/routes/*.tsx', {
  query: '?raw',
  import: 'default',
  eager: true,
});

const routeFiles = (entries: readonly RouteConfigEntry[]): string[] =>
  entries.flatMap(entry => [entry.file, ...routeFiles(entry.children ?? [])]);

describe('route session gates', () => {
  stubLocalStorage();

  beforeEach(() => useAuthStore.getState().clear());

  it('redirects missing sessions before consulting account state', async () => {
    let sessionRedirect: unknown;
    let userRedirect: unknown;
    try {
      requireDashboardSession();
    } catch (error) {
      sessionRedirect = error;
    }
    try {
      await requireDashboardUser();
    } catch (error) {
      userRedirect = error;
    }

    for (const redirect of [sessionRedirect, userRedirect]) {
      expect(redirect).toBeInstanceOf(Response);
      expect((redirect as Response).status).toBe(302);
      expect((redirect as Response).headers.get('Location')).toBe('/');
    }
  });

  it('redirects a signed-in non-admin to the operator landing page', async () => {
    useAuthStore.getState().primeFromLogin({
      token: 'operator-session',
      user: { id: 2, username: 'operator', isAdmin: false, upstreamIds: null },
    });

    const redirect = await requireDashboardAdmin().then(() => null, (error: unknown) => error);

    expect(redirect).toBeInstanceOf(Response);
    expect((redirect as Response).status).toBe(302);
    expect((redirect as Response).headers.get('Location')).toBe('/dashboard/services/api-keys');
  });

  it('wires every dashboard resource loader to its own gate', () => {
    const dashboard = routeConfig.find(entry => entry.path === 'dashboard');
    if (!dashboard) throw new Error('The dashboard route is missing');
    const files = routeFiles([dashboard]);
    for (const file of files) {
      const source = routeSources[`../../src/${file}`];
      expect(source, file).toBeDefined();
      expect(source, file).toMatch(/export (?:async )?function clientLoader\b/);
      if (file === 'routes/dashboard-index.tsx') {
        expect(source, file).toMatch(/throw redirect\('\/dashboard\/playground'\)/);
      } else {
        expect(source, file).toMatch(/\brequireDashboard(?:Session|User|Admin)\(\)/);
      }
    }
  });
});
