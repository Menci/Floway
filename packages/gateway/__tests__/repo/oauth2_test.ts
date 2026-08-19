import { test } from 'vitest';

import { InMemoryRepo } from './memory.ts';
import { createSqliteTestDb } from './test-sqlite.ts';
import { SqlRepo } from '../../src/repo/sql.ts';
import type { Repo } from '../../src/repo/types.ts';
import { assertEquals, assertExists } from '@floway-dev/test-utils';

const repoFactories: Array<[string, () => Promise<Repo>]> = [
  ['memory', async () => new InMemoryRepo()],
  ['sql', async () => new SqlRepo(await createSqliteTestDb())],
];

for (const [kind, makeRepo] of repoFactories) {
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
}
