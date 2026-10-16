import { describe, expect, test } from 'vitest';

import { InMemoryRepo } from './memory.ts';
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
});
