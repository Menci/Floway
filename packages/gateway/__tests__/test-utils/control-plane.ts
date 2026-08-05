import { Hono } from 'hono';

import { controlPlaneRoutes } from '../../src/control-plane/routes.ts';
import { type AuthVars, authMiddleware } from '../../src/middleware/auth.ts';
import { internalErrorResponse } from '../../src/middleware/internal-error-response.ts';
import { initRepo } from '../../src/repo/index.ts';
import type { ApiKey } from '../../src/repo/types.ts';
import { InMemoryRepo } from '../repo/memory.ts';
import { initEnv } from '@floway-dev/platform';

export const TEST_PASSWORD = 'persisted-password';
export const TEST_PASSWORD_HASH = 'pbkdf2-sha256$1000$AAECAwQFBgcICQoLDA0ODw==$rep5GM+JZ4GSYa/Qxf4tY9KFd/PnYjJdCeYGWosl/ug=';

interface SetupOptions {
  adminKey?: string | null;
}

const app = new Hono<{ Variables: AuthVars }>()
  .onError(internalErrorResponse)
  .use('*', authMiddleware)
  .route('/', controlPlaneRoutes);

export const setupControlPlaneTest = async (options: SetupOptions = {}) => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const adminKey = 'adminKey' in options ? options.adminKey : 'admin-test-key';
  initEnv(name => name === 'ADMIN_KEY' ? adminKey ?? undefined : '');

  await repo.users.save({
    id: 2,
    username: 'tester',
    passwordHash: null,
    isAdmin: false,
    upstreamIds: null,
    createdAt: '2026-03-15T00:00:00.000Z',
    deletedAt: null,
  });
  const apiKey: ApiKey = {
    id: 'key_test',
    userId: 2,
    name: 'Primary key',
    key: 'raw_test_key',
    serverSecret: '00'.repeat(32),
    createdAt: '2026-03-15T00:00:00.000Z',
    upstreamIds: null,
    deletedAt: null,
    dumpRetentionSeconds: null,
    responsesRetentionSeconds: 30 * 24 * 60 * 60,
  };
  await repo.apiKeys.save(apiKey);
  const adminSession = (await repo.sessions.create(1)).id;
  return { repo, adminKey: adminKey ?? '', adminSession, apiKey };
};

export const requestControlPlane = (path: string, init: RequestInit = {}): Promise<Response> => app.request(path, init);
