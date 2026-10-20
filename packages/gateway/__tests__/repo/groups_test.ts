import { describe, expect, test, vi } from 'vitest';

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

  test('soft-deleted names can be reused while historical rows remain exportable', async () => {
    const repo = await makeRepo();
    await repo.groups.save(sampleGroup());
    expect(await repo.groups.softDelete(1)).toBe(true);
    expect(await repo.groups.getById(1)).toBeNull();
    await repo.groups.save(sampleGroup({ id: 2 }));
    expect((await repo.groups.findByName('OPERATORS'))?.id).toBe(2);
    expect(await repo.groups.listIncludingDeleted()).toHaveLength(2);
  });

  test('membership replacement is deduplicated, sorted, and queryable from either side', async () => {
    const repo = await makeRepo();
    await repo.groups.save(sampleGroup());
    await repo.groups.replaceMembers(1, [4, 2, 4, 3]);
    expect(await repo.groups.listMemberIds(1)).toEqual([2, 3, 4]);
    expect(await repo.groups.listIdsByUserId(3)).toEqual([1]);
    expect(await repo.groups.listIdsByUserIds([2, 5])).toEqual(new Map([[2, [1]], [5, []]]));
  });

  test('removes every membership owned by a deleted user', async () => {
    const repo = await makeRepo();
    await repo.groups.save(sampleGroup());
    await repo.groups.save(sampleGroup({ id: 2, name: 'Platform' }));
    await repo.groups.replaceMembers(1, [2, 3]);
    await repo.groups.replaceMembers(2, [2]);
    expect(await repo.groups.deleteMembershipsByUserId(2)).toBe(2);
    expect(await repo.groups.listMemberIds(1)).toEqual([3]);
    expect(await repo.groups.listMemberIds(2)).toEqual([]);
  });

  test('concurrent additions preserve both members and bulk reads match individual reads', async () => {
    const repo = await makeRepo();
    await repo.groups.save(sampleGroup());
    const admin = await repo.users.getById(1);
    expect(admin).not.toBeNull();
    await repo.users.save({ ...admin!, id: 2, username: 'alice' });
    await Promise.all([repo.groups.setMember(1, 1, true), repo.groups.setMember(1, 2, true)]);
    expect(await repo.groups.listMemberships()).toEqual(new Map([[1, [1, 2]]]));
    await repo.groups.setMember(1, 1, false);
    expect(await repo.groups.listMemberIds(1)).toEqual([2]);
    await repo.groups.softDelete(1);
    expect(await repo.groups.listMemberIds(1)).toEqual([]);
  });

  test('saving a user with group selection leaves other members intact', async () => {
    const repo = await makeRepo();
    await repo.groups.save(sampleGroup());
    const admin = (await repo.users.getById(1))!;
    await repo.users.save({ ...admin, id: 2, username: 'alice' });
    await repo.groups.replaceMembers(1, [1, 2]);
    await repo.users.save({ ...admin, username: 'renamed' }, []);
    expect(await repo.groups.listMemberIds(1)).toEqual([2]);
    expect((await repo.users.getById(1))?.username).toBe('renamed');
  });

  test.each([
    ['ASCII', 'Platform', 'platform', true],
    ['Latin', '\u00c4', '\u00e4', false],
    ['Greek', '\u03a3', '\u03c3', false],
    ['mixed ASCII and Unicode', 'TEAM-\u00c4', 'team-\u00c4', true],
    ['mixed Unicode cases', 'TEAM-\u00c4', 'team-\u00e4', false],
  ])('uses SQLite NOCASE for %s group names', async (_label, first, second, equal) => {
    const repo = await makeRepo();
    await repo.groups.create(first, 120);
    expect((await repo.groups.findByName(second))?.name).toBe(equal ? first : undefined);
    if (equal) {
      await expect(repo.groups.create(second, 120)).rejects.toThrow();
      await expect(repo.groups.save(sampleGroup({ id: 2, name: second }))).rejects.toThrow();
    } else {
      await repo.groups.create(second, 120);
      expect(await repo.groups.list()).toHaveLength(2);
    }
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

  test('preserves joined timestamps through identity edits and membership replacement', async () => {
    const repo = await makeRepo();
    const admin = (await repo.users.getById(1))!;
    await repo.groups.save(sampleGroup());
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const joined = '2026-10-17T08:00:00.000Z';
      vi.setSystemTime(joined);
      await repo.groups.setMember(1, 1, true);
      vi.setSystemTime('2026-10-18T08:00:00.000Z');
      await repo.groups.setMember(1, 1, true);
      await repo.groups.replaceUserGroups(1, [1]);
      await repo.users.save({ ...admin, username: 'renamed' }, [1]);
      await repo.groups.save(sampleGroup({ name: 'Renamed group' }));
      await repo.groups.replaceMembers(1, [1, 1]);
      expect((await repo.readUserDirectory()).memberships).toEqual([{ groupId: 1, userId: 1, createdAt: joined }]);
    } finally {
      vi.useRealTimers();
    }
  });

  test('records a new joined timestamp only after leaving and rejoining', async () => {
    const repo = await makeRepo();
    const admin = (await repo.users.getById(1))!;
    await repo.users.save({ ...admin, id: 2, username: 'alice' });
    await repo.groups.save(sampleGroup());
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const first = '2026-10-17T08:00:00.000Z';
      const second = '2026-10-18T08:00:00.000Z';
      const third = '2026-10-19T08:00:00.000Z';
      vi.setSystemTime(first);
      await repo.groups.replaceMembers(1, [1]);
      vi.setSystemTime(second);
      await repo.groups.replaceMembers(1, [1, 2]);
      expect((await repo.readUserDirectory()).memberships).toEqual([
        { groupId: 1, userId: 1, createdAt: first },
        { groupId: 1, userId: 2, createdAt: second },
      ]);
      await repo.groups.replaceUserGroups(1, []);
      expect((await repo.readUserDirectory()).memberships).toEqual([{ groupId: 1, userId: 2, createdAt: second }]);
      vi.setSystemTime(third);
      await repo.users.save(admin, [1]);
      expect((await repo.readUserDirectory()).memberships).toEqual([
        { groupId: 1, userId: 1, createdAt: third },
        { groupId: 1, userId: 2, createdAt: second },
      ]);
    } finally {
      vi.useRealTimers();
    }
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
