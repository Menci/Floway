import { describe, expect, test } from 'vitest';

import { InMemoryRepo } from './memory.ts';
import { createSqliteTestDb } from './test-sqlite.ts';
import { SqlRepo } from '../../src/repo/sql.ts';
import type { Repo, User } from '../../src/repo/types.ts';

const sampleUser = (over: Partial<User> = {}): User => ({
  id: 0,
  username: 'alice',
  passwordHash: 'pbkdf2-sha256$600000$YQ==$YQ==',
  isAdmin: false,
  createdAt: '2026-06-07T00:00:00.000Z',
  deletedAt: null,
  ...over,
});

type RepoFactory = () => Promise<Repo>;

const makeMemoryRepo: RepoFactory = () => Promise.resolve(new InMemoryRepo());
const makeSqlRepo: RepoFactory = async () => new SqlRepo(await createSqliteTestDb());

const backends: ReadonlyArray<readonly [string, RepoFactory]> = [
  ['memory', makeMemoryRepo],
  ['sql', makeSqlRepo],
];

describe.each(backends)('UsersRepo (%s)', (_label, makeRepo) => {

  test('softDelete hides from list and getById, but the *IncludingDeleted variants still return the row', async () => {
    const repo = await makeRepo();
    await repo.users.save(sampleUser({ id: 2 }));
    expect(await repo.users.softDelete(2)).toBe(true);
    expect((await repo.users.list()).find(u => u.id === 2)).toBeUndefined();
    expect(await repo.users.getById(2)).toBeNull();
    const including = (await repo.users.listIncludingDeleted()).find(u => u.id === 2);
    expect(including).toBeDefined();
    expect(including!.deletedAt).not.toBeNull();
  });

  test('deleted username can be reused by a new user (partial unique index)', async () => {
    const repo = await makeRepo();
    await repo.users.save(sampleUser({ id: 2, username: 'alice' }));
    await repo.users.softDelete(2);
    await repo.users.save(sampleUser({ id: 3, username: 'alice' }));
    expect((await repo.users.findByUsername('alice'))?.id).toBe(3);
  });

  test('saving an active username that differs only in case throws', async () => {
    const repo = await makeRepo();
    await repo.users.save(sampleUser({ id: 2, username: 'alice' }));
    await expect(repo.users.save(sampleUser({ id: 3, username: 'Alice' }))).rejects.toThrow();
  });
});
