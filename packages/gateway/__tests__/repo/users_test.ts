import { describe, expect, test } from 'vitest';

import { InMemoryRepo } from './memory.ts';
import { createSqliteTestDb } from './test-sqlite.ts';
import { SqlRepo } from '../../src/repo/sql.ts';
import type { ApiKey, NewUserDefaultKey, Repo, User } from '../../src/repo/types.ts';

const sampleUser = (over: Partial<User> = {}): User => ({
  id: 0,
  username: 'alice',
  passwordHash: 'pbkdf2-sha256$1000$AAECAwQFBgcICQoLDA0ODw==$rep5GM+JZ4GSYa/Qxf4tY9KFd/PnYjJdCeYGWosl/ug=',
  isAdmin: false,
  upstreamIds: null,
  createdAt: '2026-06-07T00:00:00.000Z',
  deletedAt: null,
  ...over,
});

const defaultKey = (overrides: Partial<NewUserDefaultKey> = {}): NewUserDefaultKey => ({
  id: 'key_default',
  name: 'Default',
  key: 'raw_default',
  serverSecret: '11'.repeat(32),
  createdAt: '2026-06-07T00:00:00.000Z',
  upstreamIds: null,
  dumpRetentionSeconds: null,
  responsesRetentionSeconds: 0,
  ...overrides,
});

const accountTemplate = (username: string) => ({
  username,
  passwordHash: null,
  isAdmin: false,
  upstreamIds: null,
  createdAt: '2026-06-07T00:00:00.000Z',
});

const storedKey = (userId: number, overrides: Partial<ApiKey> = {}): ApiKey => ({
  ...defaultKey(),
  userId,
  deletedAt: null,
  ...overrides,
});

type RepoFactory = () => Promise<Repo>;

const makeMemoryRepo: RepoFactory = () => Promise.resolve(new InMemoryRepo());
const makeSqlRepo: RepoFactory = async () => new SqlRepo(await createSqliteTestDb());

const backends: ReadonlyArray<readonly [string, RepoFactory]> = [
  ['memory', makeMemoryRepo],
  ['sql', makeSqlRepo],
];

describe.each(backends)('UsersRepo (%s)', (_label, makeRepo) => {
  test('createAccount commits one user and its Default key', async () => {
    const repo = await makeRepo();
    const result = await repo.users.createAccount(accountTemplate('alice'), defaultKey());
    expect(result.status).toBe('created');
    if (result.status !== 'created') throw new Error('expected account creation');
    expect(await repo.users.getById(result.user.id)).toEqual(result.user);
    expect((await repo.apiKeys.listByUserId(result.user.id)).map(key => key.id)).toEqual(['key_default']);
  });

  test('createAccount refuses to cross the safe-integer user id boundary', async () => {
    const repo = await makeRepo();
    await repo.users.save(sampleUser({ id: Number.MAX_SAFE_INTEGER, username: 'last-safe-user' }));

    const result = await repo.users.createAccount(accountTemplate('alice'), defaultKey());

    expect(result).toEqual({ status: 'id-exhausted' });
    expect(await repo.users.findByUsername('alice')).toBeNull();
    expect(await repo.apiKeys.getById('key_default')).toBeNull();
  });

  test('concurrent duplicate createAccount calls return one account and one username conflict', async () => {
    const repo = await makeRepo();
    const results = await Promise.all([
      repo.users.createAccount(accountTemplate('alice'), defaultKey({ id: 'key_a', key: 'raw_a', serverSecret: 'aa'.repeat(32) })),
      repo.users.createAccount(accountTemplate('Alice'), defaultKey({ id: 'key_b', key: 'raw_b', serverSecret: 'bb'.repeat(32) })),
    ]);
    expect(results.map(result => result.status).toSorted()).toEqual(['created', 'username-taken']);
    expect((await repo.users.list()).filter(user => user.id !== 1)).toHaveLength(1);
    expect((await repo.apiKeys.list()).filter(key => key.userId !== 1)).toHaveLength(1);
  });

  test('a Default-key constraint failure rolls back the new user', async () => {
    const repo = await makeRepo();
    await repo.apiKeys.save(storedKey(1, { id: 'existing', key: 'raw_collision', serverSecret: '22'.repeat(32) }));
    await expect(repo.users.createAccount(
      accountTemplate('alice'),
      defaultKey({ id: 'new-key', key: 'raw_collision', serverSecret: '33'.repeat(32) }),
    )).rejects.toThrow(/api_keys\.key/);
    expect(await repo.users.findByUsername('alice')).toBeNull();
    expect(await repo.apiKeys.getById('new-key')).toBeNull();
  });

  test('concurrent disjoint updateActive calls preserve both fields', async () => {
    const repo = await makeRepo();
    await repo.users.save(sampleUser({ id: 2, username: 'alice', isAdmin: false }));
    const results = await Promise.all([
      repo.users.updateActive(2, { username: 'renamed' }),
      repo.users.updateActive(2, { isAdmin: true }),
    ]);
    expect(results.map(result => result.status)).toEqual(['updated', 'updated']);
    expect(await repo.users.getById(2)).toMatchObject({ username: 'renamed', isAdmin: true });
  });

  test('password update and session revocation commit as one account mutation', async () => {
    const repo = await makeRepo();
    await repo.users.save(sampleUser({ id: 2, passwordHash: null }));
    const keep = await repo.sessions.create(2);
    const revoke = await repo.sessions.create(2);

    const result = await repo.users.updateActive(2, { passwordHash: sampleUser().passwordHash }, { keepSessionId: keep.id });
    expect(result.status).toBe('updated');
    expect((await repo.users.getById(2))?.passwordHash).toBe(sampleUser().passwordHash);
    expect(await repo.sessions.getByIdAndTouch(keep.id)).not.toBeNull();
    expect(await repo.sessions.getByIdAndTouch(revoke.id)).toBeNull();
  });

  test('deleteAccount atomically removes sessions and soft-deletes all active keys', async () => {
    const repo = await makeRepo();
    await repo.users.save(sampleUser({ id: 2 }));
    await repo.apiKeys.save(storedKey(2, { id: 'key_a', key: 'raw_a', serverSecret: 'aa'.repeat(32) }));
    await repo.apiKeys.save(storedKey(2, { id: 'key_b', key: 'raw_b', serverSecret: 'bb'.repeat(32) }));
    const session = await repo.sessions.create(2);

    const deletion = await repo.users.deleteAccount(2, '2026-06-08T00:00:00.000Z');
    expect(deletion.status).toBe('deleted');
    if (deletion.status !== 'deleted') throw new Error('expected account deletion');
    expect(deletion.apiKeyIds.toSorted()).toEqual(['key_a', 'key_b']);
    expect(await repo.users.getById(2)).toBeNull();
    expect(await repo.apiKeys.getById('key_a')).toBeNull();
    expect(await repo.apiKeys.getById('key_b')).toBeNull();
    expect(await repo.sessions.getByIdAndTouch(session.id)).toBeNull();
  });

  test('save then list returns active users sorted by id (excluding seed admin)', async () => {
    const repo = await makeRepo();
    await repo.users.save(sampleUser({ id: 2, username: 'alice' }));
    await repo.users.save(sampleUser({ id: 3, username: 'bob' }));
    const list = (await repo.users.list()).filter(u => u.id !== 1);
    expect(list.map(u => u.username)).toEqual(['alice', 'bob']);
  });

  test('deleteAccount hides from list and getById, but the *IncludingDeleted variants still return the row', async () => {
    const repo = await makeRepo();
    await repo.users.save(sampleUser({ id: 2 }));
    expect(await repo.users.deleteAccount(2, '2026-06-08T00:00:00.000Z')).toEqual({ status: 'deleted', apiKeyIds: [] });
    expect((await repo.users.list()).find(u => u.id === 2)).toBeUndefined();
    expect(await repo.users.getById(2)).toBeNull();
    const including = (await repo.users.listIncludingDeleted()).find(u => u.id === 2);
    expect(including).toBeDefined();
    expect(including!.deletedAt).not.toBeNull();
  });

  test('deleteAccount reports an unknown or already-deleted user as missing', async () => {
    const repo = await makeRepo();
    expect(await repo.users.deleteAccount(42, '2026-06-08T00:00:00.000Z')).toEqual({ status: 'missing' });
    await repo.users.save(sampleUser({ id: 2 }));
    expect((await repo.users.deleteAccount(2, '2026-06-08T00:00:00.000Z')).status).toBe('deleted');
    expect(await repo.users.deleteAccount(2, '2026-06-09T00:00:00.000Z')).toEqual({ status: 'missing' });
  });

  test('deleted username can be reused by a new user (partial unique index)', async () => {
    const repo = await makeRepo();
    await repo.users.save(sampleUser({ id: 2, username: 'alice' }));
    await repo.users.deleteAccount(2, '2026-06-08T00:00:00.000Z');
    await repo.users.save(sampleUser({ id: 3, username: 'alice' }));
    expect((await repo.users.findByUsername('alice'))?.id).toBe(3);
  });

  test('saving a duplicate active username throws', async () => {
    const repo = await makeRepo();
    await repo.users.save(sampleUser({ id: 2, username: 'alice' }));
    await expect(repo.users.save(sampleUser({ id: 3, username: 'alice' }))).rejects.toThrow();
  });

  test('save updates an existing row', async () => {
    const repo = await makeRepo();
    await repo.users.save(sampleUser({ id: 2, username: 'alice', isAdmin: false }));
    await repo.users.save(sampleUser({ id: 2, username: 'alice', isAdmin: true }));
    expect((await repo.users.getById(2))?.isAdmin).toBe(true);
  });

  test('upstreamIds round-trip null and array forms', async () => {
    const repo = await makeRepo();
    await repo.users.save(sampleUser({ id: 2, username: 'a', upstreamIds: null }));
    await repo.users.save(sampleUser({ id: 3, username: 'b', upstreamIds: ['up_one', 'up_two'] }));
    expect((await repo.users.getById(2))?.upstreamIds).toBeNull();
    expect((await repo.users.getById(3))?.upstreamIds).toEqual(['up_one', 'up_two']);
  });

  test('findByUsername does not return soft-deleted rows', async () => {
    const repo = await makeRepo();
    await repo.users.save(sampleUser({ id: 2, username: 'alice' }));
    await repo.users.deleteAccount(2, '2026-06-08T00:00:00.000Z');
    expect(await repo.users.findByUsername('alice')).toBeNull();
  });
});

test('memory deleteAccount leaves the aggregate untouched when retention scheduling fails', async () => {
  const repo = new InMemoryRepo();
  await repo.users.save(sampleUser({ id: 2 }));
  const key = storedKey(2);
  await repo.apiKeys.save(key);
  const session = await repo.sessions.create(2);
  repo.expirationSweeps.schedule = () => Promise.reject(new Error('scheduler unavailable'));

  await expect(repo.users.deleteAccount(2, '2026-06-08T00:00:00.000Z')).rejects.toThrow('scheduler unavailable');
  expect(await repo.users.getById(2)).not.toBeNull();
  expect(await repo.apiKeys.getById(key.id)).not.toBeNull();
  expect(await repo.sessions.getByIdAndTouch(session.id)).not.toBeNull();
});

test('SQL deleteAccount rolls back keys and user when a middle statement fails', async () => {
  const db = await createSqliteTestDb();
  const repo = new SqlRepo(db);
  await repo.users.save(sampleUser({ id: 2 }));
  const key = storedKey(2);
  await repo.apiKeys.save(key);
  const session = await repo.sessions.create(2);
  await db.exec(`CREATE TRIGGER fail_session_delete BEFORE DELETE ON sessions
    BEGIN SELECT RAISE(ABORT, 'session deletion failed'); END;`);

  await expect(repo.users.deleteAccount(2, '2026-06-08T00:00:00.000Z')).rejects.toThrow('session deletion failed');
  expect(await repo.users.getById(2)).not.toBeNull();
  expect(await repo.apiKeys.getById(key.id)).not.toBeNull();
  expect(await repo.sessions.getByIdAndTouch(session.id)).not.toBeNull();
});

test('SQL password update rolls back when session revocation fails', async () => {
  const db = await createSqliteTestDb();
  const repo = new SqlRepo(db);
  await repo.users.save(sampleUser({ id: 2, passwordHash: null }));
  const session = await repo.sessions.create(2);
  await db.exec(`CREATE TRIGGER fail_password_session_delete BEFORE DELETE ON sessions
    BEGIN SELECT RAISE(ABORT, 'password session deletion failed'); END;`);

  await expect(repo.users.updateActive(2, { passwordHash: sampleUser().passwordHash }, { keepSessionId: null }))
    .rejects.toThrow('password session deletion failed');
  expect((await repo.users.getById(2))?.passwordHash).toBeNull();
  expect(await repo.sessions.getByIdAndTouch(session.id)).not.toBeNull();
});
