import { test } from 'vitest';

import { InMemoryRepo } from './memory.ts';
import { createSqliteTestDb } from './test-sqlite.ts';
import { SqlRepo } from '../../src/repo/sql.ts';
import type { OAuth2Provider, Repo } from '../../src/repo/types.ts';
import { assertEquals, assertExists } from '@floway-dev/test-utils';

const repoFactories: Array<[string, () => Promise<Repo>]> = [
  ['memory', async () => new InMemoryRepo()],
  ['sql', async () => new SqlRepo(await createSqliteTestDb())],
];

const provider: OAuth2Provider = {
  id: 'custom',
  displayName: 'Example ID',
  enabled: true,
  clientId: 'floway-client',
  clientSecret: 'floway-secret',
  authorizationEndpoint: 'https://id.example.com/oauth/authorize',
  tokenEndpoint: 'https://id.example.com/oauth/token',
  userInfoEndpoint: 'https://id.example.com/api/user',
  scopes: ['profile', 'email'],
  clientAuthentication: 'client_secret_basic',
  userIdClaim: 'data.subject',
  usernameClaim: 'data.login',
  authorizationParams: { prompt: 'login', access_type: 'offline' },
  accessPolicy: { logic: 'and', conditions: [] },
  createdAt: '2026-08-19T00:00:00.000Z',
  updatedAt: '2026-08-19T00:00:00.000Z',
};

for (const [kind, makeRepo] of repoFactories) {
  test(`OAuth2 configuration repository round-trips settings and providers (${kind})`, async () => {
    const config = (await makeRepo()).oauth2Config;
    assertEquals((await config.getSettings()).publicBaseUrl, '');

    await config.saveSettings({
      publicBaseUrl: 'https://floway.example.com',
      updatedAt: provider.updatedAt,
    });
    await config.insertProvider(provider);
    await config.insertProvider({
      ...provider,
      id: 'first',
      displayName: 'First',
      clientSecret: 'first-secret',
      createdAt: '2026-08-18T00:00:00.000Z',
    });

    assertEquals(await config.getSettings(), {
      publicBaseUrl: 'https://floway.example.com',
      updatedAt: provider.updatedAt,
    });
    assertEquals((await config.listProviders()).map(item => item.id), ['first', 'custom']);
    assertEquals(await config.getProviderById('custom'), provider);

    const updated = {
      ...provider,
      displayName: 'Updated',
      enabled: false,
      scopes: ['read:user', 'read:organization'],
      authorizationParams: { audience: 'floway' },
      accessPolicy: {
        logic: 'or' as const,
        conditions: [{ field: 'groups', op: 'contains' as const, value: 'company:owners' }],
      },
      updatedAt: '2026-08-19T01:00:00.000Z',
    };
    assertEquals(await config.updateProvider(updated), true);
    assertEquals(await config.getProviderById('custom'), updated);
    assertEquals(await config.updateProvider({ ...updated, id: 'missing' }), false);

    assertEquals(await config.deleteProvider('custom'), true);
    assertEquals(await config.deleteProvider('custom'), false);
    assertEquals(await config.getProviderById('custom'), null);
  });

  test(`OAuth2 configuration deleteAll resets the singleton and provider catalog (${kind})`, async () => {
    const config = (await makeRepo()).oauth2Config;
    await config.saveSettings({ publicBaseUrl: 'https://floway.example.com', updatedAt: provider.updatedAt });
    await config.saveProvider(provider);

    await config.deleteAll();

    assertEquals((await config.getSettings()).publicBaseUrl, '');
    assertEquals(await config.listProviders(), []);
  });

  test(`OAuth2 repository completes registration atomically (${kind})`, async () => {
    const repo = await makeRepo();
    const now = Date.now();
    await repo.oauth2.createHandoff({
      tokenHash: 'registration-hash',
      providerId: 'custom',
      providerUserId: 'provider-user-1',
      providerLogin: 'alice@example.com',
      userId: null,
      createdAt: '2026-08-19T00:00:00.000Z',
      expiresAt: now + 60_000,
    });

    const registration = (suffix: string) => repo.oauth2.register({
      tokenHash: 'registration-hash',
      username: `alice-${suffix}`,
      createdAt: '2026-08-19T00:00:00.000Z',
      now,
      defaultKey: {
        id: `key-oauth2-${suffix}`,
        name: 'Default',
        key: `sk-oauth2-${suffix}`,
        serverSecret: 'ab'.repeat(32),
        createdAt: '2026-08-19T00:00:00.000Z',
        upstreamIds: null,
        deletedAt: null,
        dumpRetentionSeconds: null,
        responsesRetentionSeconds: 0,
      },
    });
    const results = await Promise.all([registration('one'), registration('two')]);
    const created = results.filter(result => result.status === 'created');

    assertEquals(results.map(result => result.status).toSorted(), ['created', 'missing']);
    if (created[0]?.status !== 'created') throw new Error('expected exactly one created registration');
    assertEquals(created[0].user.passwordHash, null);
    assertEquals(created[0].user.isAdmin, false);
    assertEquals((await repo.apiKeys.listByUserId(created[0].user.id)).map(key => key.id), [`key-oauth2-${created[0].user.username.slice(-3)}`]);
    assertEquals((await repo.oauth2.listAccounts()).map(account => account.providerUserId), ['provider-user-1']);
    assertEquals(await repo.oauth2.getHandoff('registration-hash', now), null);
    assertExists(await repo.sessions.getByIdAndTouch(created[0].session.id));
  });

  test(`OAuth2 login handoff is single-use (${kind})`, async () => {
    const repo = await makeRepo();
    const now = Date.now();
    await repo.oauth2.createHandoff({
      tokenHash: 'login-hash',
      providerId: 'custom',
      providerUserId: 'provider-user-1',
      providerLogin: 'alice',
      userId: 1,
      createdAt: '2026-08-19T00:00:00.000Z',
      expiresAt: now + 60_000,
    });

    const sessions = await Promise.all([
      repo.oauth2.completeLogin('login-hash', now),
      repo.oauth2.completeLogin('login-hash', now),
    ]);
    const created = sessions.filter(session => session !== null);
    assertEquals(created.length, 1);
    assertEquals(created[0]?.userId, 1);
  });

  test(`OAuth2 binding and unlink keep at least one login credential (${kind})`, async () => {
    const repo = await makeRepo();
    await repo.users.save({
      id: 3,
      username: 'oauth-user',
      passwordHash: null,
      isAdmin: false,
      upstreamIds: null,
      createdAt: '2026-08-19T00:00:00.000Z',
      deletedAt: null,
    });
    const account = (providerId: string, providerUserId: string, userId = 3) => ({
      providerId,
      providerUserId,
      userId,
      providerLogin: `${providerId}-login`,
      createdAt: '2026-08-19T00:00:00.000Z',
      lastLoginAt: '2026-08-19T00:00:00.000Z',
    });

    assertEquals(await repo.oauth2.bindAccount(account('first', 'identity-one', 99)), 'user-not-found');
    assertEquals(await repo.oauth2.bindAccount(account('first', 'identity-one')), 'bound');
    assertEquals(await repo.oauth2.bindAccount(account('first', 'identity-one', 1)), 'account-taken');
    assertEquals(await repo.oauth2.bindAccount(account('first', 'another-identity')), 'account-taken');
    assertEquals(await repo.oauth2.unlinkAccount(3, 'first'), 'last-login');

    assertEquals(await repo.oauth2.bindAccount(account('second', 'identity-two')), 'bound');
    assertEquals((await repo.oauth2.listAccountsByUserId(3)).map(item => item.providerId), ['first', 'second']);
    assertEquals(await repo.oauth2.unlinkAccount(3, 'first'), 'deleted');
    assertEquals(await repo.oauth2.unlinkAccount(3, 'second'), 'last-login');

    const user = await repo.users.getById(3);
    assertExists(user);
    await repo.users.save({ ...user, passwordHash: 'scrypt$placeholder' });
    assertEquals(await repo.oauth2.unlinkAccount(3, 'second'), 'deleted');
    assertEquals(await repo.oauth2.listAccountsByUserId(3), []);
  });
}
