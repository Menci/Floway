import { describe, expect, test } from 'vitest';

import { InMemoryRepo } from './memory.ts';
import { createSqliteTestDb } from './test-sqlite.ts';
import { SqlRepo } from '../../src/repo/sql.ts';
import type { Repo } from '../../src/repo/types.ts';

type RepoFactory = () => Promise<Repo>;

const makeMemoryRepo: RepoFactory = () => Promise.resolve(new InMemoryRepo());
const makeSqlRepo: RepoFactory = async () => new SqlRepo(await createSqliteTestDb());

const backends: ReadonlyArray<readonly [string, RepoFactory]> = [
  ['memory', makeMemoryRepo],
  ['sql', makeSqlRepo],
];

describe.each(backends)('SessionsRepo (%s)', (_label, makeRepo) => {
  test('createForActiveUser refuses to attach a session after account deletion', async () => {
    const repo = await makeRepo();
    await repo.users.save({
      id: 2,
      username: 'alice',
      passwordHash: null,
      isAdmin: false,
      upstreamIds: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      deletedAt: null,
    });
    expect(await repo.sessions.createForActiveUser(2)).not.toBeNull();
    await repo.users.deleteAccount(2, '2026-01-02T00:00:00.000Z');
    expect(await repo.sessions.createForActiveUser(2)).toBeNull();
  });

  test('create returns a 64-hex token attached to the user', async () => {
    const repo = await makeRepo();
    const session = await repo.sessions.create(1);
    expect(session.userId).toBe(1);
    expect(session.id).toMatch(/^[0-9a-f]{64}$/);
    expect(session.createdAt).toBe(session.lastSeenAt);
  });

  test('getByIdAndTouch returns the session and bumps last_seen_at', async () => {
    const repo = await makeRepo();
    const session = await repo.sessions.create(1);
    await new Promise(resolve => setTimeout(resolve, 5));
    const touched = await repo.sessions.getByIdAndTouch(session.id);
    expect(touched).not.toBeNull();
    expect(touched!.id).toBe(session.id);
    expect(touched!.lastSeenAt > session.lastSeenAt).toBe(true);
  });

  test('getByIdAndTouch returns null for an unknown id', async () => {
    const repo = await makeRepo();
    expect(await repo.sessions.getByIdAndTouch('deadbeef'.repeat(8))).toBeNull();
  });

  test('deleteById removes only the targeted session', async () => {
    const repo = await makeRepo();
    const a = await repo.sessions.create(1);
    const b = await repo.sessions.create(1);
    expect(await repo.sessions.deleteById(a.id)).toBe(true);
    expect(await repo.sessions.deleteById(a.id)).toBe(false);
    expect(await repo.sessions.getByIdAndTouch(b.id)).not.toBeNull();
  });

  test('deleteAll wipes the table', async () => {
    const repo = await makeRepo();
    const a = await repo.sessions.create(1);
    const b = await repo.sessions.create(2);
    await repo.sessions.deleteAll();
    expect(await repo.sessions.getByIdAndTouch(a.id)).toBeNull();
    expect(await repo.sessions.getByIdAndTouch(b.id)).toBeNull();
  });
});
