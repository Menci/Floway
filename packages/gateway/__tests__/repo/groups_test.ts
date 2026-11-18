import { describe, expect, test } from 'vitest';

import { InMemoryRepo } from './memory.ts';
import { recordCompletedStatements } from './recording-sql.ts';
import { createSqliteTestDb } from './test-sqlite.ts';
import { SqlRepo } from '../../src/repo/sql.ts';
import type { Group, Repo } from '../../src/repo/types.ts';

const sampleGroup = (overrides: Partial<Group> = {}): Group => ({
  id: 1,
  name: 'Operators', hue: 120,
  createdAt: '2026-10-16T00:00:00.000Z',
  deletedAt: null,
  ...overrides,
});

type RepoFactory = () => Promise<Repo>;
const backends: ReadonlyArray<readonly [string, RepoFactory]> = [
  ['memory', () => Promise.resolve(new InMemoryRepo())],
  ['sql', async () => new SqlRepo(await createSqliteTestDb())],
];

describe.each(backends)('GroupsRepo (%s)', (_label, makeRepo) => {
  test('creates groups with monotonic ids and case-insensitive unique names', async () => {
    const repo = await makeRepo();
    expect(await repo.groups.create('Operators', 120)).toMatchObject({ id: 1, name: 'Operators' });
    expect(await repo.groups.create('Platform', 120)).toMatchObject({ id: 2, name: 'Platform' });
    await expect(repo.groups.create('operators', 120)).rejects.toThrow();
  });

  test('membership replacement is deduplicated, sorted, and queryable from either side', async () => {
    const repo = await makeRepo();
    await repo.groups.save(sampleGroup());
    await repo.groups.replaceMembers(1, [4, 2, 4, 3]);
    expect(await repo.groups.listMemberIds(1)).toEqual([2, 3, 4]);
    expect(await repo.groups.listIdsByUserId(3)).toEqual([1]);
    expect(await repo.groups.listIdsByUserIds([2, 5])).toEqual(new Map([[2, [1]], [5, []]]));
  });

  test('restores name swaps and memberships without disturbing other groups', async () => {
    const repo = await makeRepo();
    await repo.groups.save(sampleGroup({ id: 1, name: 'Ops' }));
    await repo.groups.save(sampleGroup({ id: 2, name: 'Research' }));
    await repo.groups.save(sampleGroup({ id: 3, name: 'Untouched' }));
    await repo.groups.replaceMembers(3, [1]);
    await repo.groups.restore([
      { ...sampleGroup({ id: 1, name: 'Research' }), memberIds: [1] },
      { ...sampleGroup({ id: 2, name: 'Ops' }), memberIds: [] },
    ]);
    expect((await repo.groups.list()).map(group => group.name)).toEqual(['Research', 'Ops', 'Untouched']);
    expect(await repo.groups.listMemberIds(1)).toEqual([1]);
    expect(await repo.groups.listMemberIds(2)).toEqual([]);
    expect(await repo.groups.listMemberIds(3)).toEqual([1]);
  });

  test('rolls back a failed group restore including released names and memberships', async () => {
    const repo = await makeRepo();
    await repo.groups.save(sampleGroup({ id: 1, name: 'Original' }));
    await repo.groups.replaceMembers(1, [1]);
    const before = await repo.groups.listIncludingDeleted();
    await expect(repo.groups.restore([
      { ...sampleGroup({ id: 1, name: 'Ops' }), memberIds: [] },
      { ...sampleGroup({ id: 2, name: 'ops' }), memberIds: [] },
    ])).rejects.toThrow();
    expect(await repo.groups.listIncludingDeleted()).toEqual(before);
    expect(await repo.groups.listMemberIds(1)).toEqual([1]);
  });

  test('directory snapshots include only active users, groups and their memberships', async () => {
    const repo = await makeRepo();
    const admin = (await repo.users.getById(1))!;
    await repo.users.save({ ...admin, id: 2, username: 'deleted', deletedAt: '2026-10-16T00:00:00Z' });
    await repo.groups.save(sampleGroup());
    await repo.groups.save(sampleGroup({ id: 2, name: 'Deleted', deletedAt: '2026-10-16T00:00:00Z' }));
    await repo.groups.replaceMembers(1, [1, 2, 999]);
    await repo.groups.replaceMembers(2, [1]);
    expect(await repo.readUserDirectory()).toEqual({
      users: [admin], groups: [sampleGroup()],
      memberships: [{ groupId: 1, userId: 1, createdAt: expect.any(String) }],
    });
  });
});

test('SQL directory reads users and membership in one statement before a concurrent deletion', async () => {
  const db = await createSqliteTestDb();
  const writer = new SqlRepo(db);
  await writer.groups.save(sampleGroup());
  await writer.groups.replaceMembers(1, [1]);
  const completed: import('./recording-sql.ts').CompletedStatement[] = [];
  const observed = recordCompletedStatements(db, completed);
  const reader = new SqlRepo({
    prepare(query) {
      const statement = observed.prepare(query);
      return {
        bind: (...values) => statement.bind(...values),
        first: () => statement.first(),
        run: () => statement.run(),
        async all<T>() {
          const result = await statement.all<T>();
          await writer.groups.softDelete(1);
          return result;
        },
      };
    },
    exec: sql => db.exec(sql),
  });
  const directory = await reader.readUserDirectory();
  expect(completed).toHaveLength(1);
  expect(directory.users.map(user => user.id)).toEqual([1]);
  expect(directory.groups).toEqual([sampleGroup()]);
  expect(directory.memberships).toEqual([{ groupId: 1, userId: 1, createdAt: expect.any(String) }]);
  expect((await writer.readUserDirectory()).groups).toEqual([]);
  expect((await writer.readUserDirectory()).memberships).toEqual([]);
});

test('group restore requires atomic batches before changing any records', async () => {
  const db = await createSqliteTestDb();
  const writer = new SqlRepo(db);
  await writer.groups.save(sampleGroup());
  const reader = new SqlRepo({ prepare: query => db.prepare(query), exec: sql => db.exec(sql) });
  await expect(reader.groups.restore([{ ...sampleGroup({ name: 'Changed' }), memberIds: [] }])).rejects.toThrow('atomic SQL batch support');
  expect(await writer.groups.list()).toEqual([sampleGroup()]);
});
