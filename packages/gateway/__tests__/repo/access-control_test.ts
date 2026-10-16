import { describe, expect, test } from 'vitest';

import { InMemoryRepo } from './memory.ts';
import { createSqliteTestDb } from './test-sqlite.ts';
import { SqlRepo } from '../../src/repo/sql.ts';
import type { Repo } from '../../src/repo/types.ts';

type RepoFactory = () => Promise<Repo>;
const backends: ReadonlyArray<readonly [string, RepoFactory]> = [
  ['memory', () => Promise.resolve(new InMemoryRepo())],
  ['sql', async () => new SqlRepo(await createSqliteTestDb())],
];

describe.each(backends)('access-control repos (%s)', (_label, makeRepo) => {
  test('groups persist members in both lookup directions', async () => {
    const repo = await makeRepo();
    const group = await repo.groups.create('Operators', 120);
    await repo.groups.replaceMembers(group.id, [3, 2, 3]);

    expect(await repo.groups.listMemberIds(group.id)).toEqual([2, 3]);
    expect(await repo.groups.listIdsByUserId(2)).toEqual([group.id]);
    expect(await repo.groups.listIdsByUserIds([2, 4])).toEqual(new Map([[2, [group.id]], [4, []]]));
  });

  test('soft-deleted groups no longer contribute principal membership', async () => {
    const repo = await makeRepo();
    const group = await repo.groups.create('Operators', 120);
    await repo.groups.replaceMembers(group.id, [2]);
    await repo.groups.softDelete(group.id);

    expect(await repo.groups.listIdsByUserId(2)).toEqual([]);
  });

  test('access records upsert one principal-scope cell', async () => {
    const repo = await makeRepo();
    const principal = { kind: 'user' as const, id: 2 };
    const scope = { kind: 'upstream' as const, upstreamId: 'up_a' };
    const first = await repo.accessRecords.save({ principal, scope, sortOrder: 0, values: { 'Model.Use': true } });
    const second = await repo.accessRecords.save({ principal, scope, sortOrder: 0, values: { 'Model.Use': false } });

    expect(second.id).toBe(first.id);
    expect((await repo.accessRecords.listByPrincipal(principal)).map(record => record.values)).toEqual([{ 'Model.Use': false }]);
  });

  test('access records can replace principal and scope by id', async () => {
    const repo = await makeRepo();
    const record = await repo.accessRecords.save({
      principal: { kind: 'user', id: 2 },
      scope: { kind: 'upstream', upstreamId: 'up_a' },
      sortOrder: 0,
      values: { 'Model.Use': true },
    });
    const replaced = await repo.accessRecords.replace(record.id, {
      principal: { kind: 'group', id: 3 },
      scope: { kind: 'user', userId: 4 },
      sortOrder: 0,
      values: { 'User.Audit': true },
    });
    expect(replaced).toMatchObject({
      id: record.id,
      principal: { kind: 'group', id: 3 },
      scope: { kind: 'user', userId: 4 },
      values: { 'User.Audit': true },
    });
  });

  test('duplicate sort orders at the same hierarchy level are rejected', async () => {
    const repo = await makeRepo();
    const principal = { kind: 'user' as const, id: 2 };
    await repo.accessRecords.save({
      principal,
      scope: { kind: 'upstreamModel', upstreamId: 'up_a', model: { kind: 'regex', value: '^gpt' } },
      sortOrder: 0,
      values: { 'Model.Use': true },
    });
    await expect(repo.accessRecords.save({
      principal,
      scope: { kind: 'upstreamModel', upstreamId: 'up_a', model: { kind: 'exact', value: 'gpt-5' } },
      sortOrder: 0,
      values: { 'Model.Use': false },
    })).rejects.toThrow(/sortOrder/);
  });
});
