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

  test('a semantic duplicate replaces the existing cell regardless of JSON key order', async () => {
    const repo = await makeRepo();
    const principal = { kind: 'user' as const, id: 2 };
    const scope = { kind: 'upstreamModel' as const, upstreamId: 'up_a', model: { kind: 'exact' as const, value: 'gpt-5' } };
    const first = await repo.accessRecords.save({ principal, scope, sortOrder: 0, values: { 'Model.Use': true } });
    const reorderedScope = { model: { value: scope.model.value, kind: scope.model.kind }, upstreamId: scope.upstreamId, kind: scope.kind };
    const second = await repo.accessRecords.save({ principal, scope: reorderedScope, sortOrder: 0, values: { 'Model.Use': false } });
    expect(second.id).toBe(first.id);
    expect(await repo.accessRecords.listByPrincipal(principal)).toMatchObject([{ id: first.id, values: { 'Model.Use': false } }]);
  });

  test('stale edits preserve a concurrent model reorder across principals', async () => {
    const repo = await makeRepo();
    const principal = { kind: 'user' as const, id: 2 };
    const first = await repo.accessRecords.save({ principal, scope: { kind: 'upstreamModel', upstreamId: 'up_a', model: { kind: 'exact', value: 'gpt-5' } }, sortOrder: 0, values: { 'Model.Use': true } });
    const second = await repo.accessRecords.save({ principal: { kind: 'group', id: 3 }, scope: { kind: 'upstreamModel', upstreamId: 'up_a', model: { kind: 'regex', value: '^gpt' } }, sortOrder: 1, values: { 'Model.Use': true } });
    await repo.accessRecords.reorderModel('up_a', [first.id, second.id], [second.id, first.id]);
    const edited = await repo.accessRecords.replace(first.id, { principal, scope: first.scope, sortOrder: first.sortOrder, values: { 'Model.Use': false } });
    expect(edited).toMatchObject({ sortOrder: 1, values: { 'Model.Use': false } });
    expect((await repo.accessRecords.getById(second.id))!.sortOrder).toBe(0);
  });

  test('model-pattern reorder updates a complete upstream segment atomically', async () => {
    const repo = await makeRepo();
    const first = await repo.accessRecords.save({ principal: { kind: 'user', id: 2 }, scope: { kind: 'upstreamModel', upstreamId: 'up_a', model: { kind: 'regex', value: '^gpt' } }, sortOrder: 5, values: { 'Model.Use': false } });
    const second = await repo.accessRecords.save({ principal: { kind: 'group', id: 3 }, scope: { kind: 'upstreamModel', upstreamId: 'up_a', model: { kind: 'exact', value: 'gpt-5' } }, sortOrder: 9, values: { 'Model.Use': true } });
    const unrelated = await repo.accessRecords.save({ principal: { kind: 'user', id: 2 }, scope: { kind: 'upstreamModel', upstreamId: 'up_b', model: { kind: 'exact', value: 'gpt-5' } }, sortOrder: 0, values: { 'Model.Use': true } });
    const updated = await repo.accessRecords.reorderModel('up_a', [first.id, second.id], [second.id, first.id]);
    expect(updated!.toSorted((a, b) => a.sortOrder - b.sortOrder).map(row => [row.id, row.sortOrder])).toEqual([[second.id, 0], [first.id, 1]]);
    expect(await repo.accessRecords.getById(unrelated.id)).toEqual(unrelated);
    const committed = await repo.accessRecords.list();
    expect(await repo.accessRecords.reorderModel('up_a', [first.id, second.id], [second.id, first.id])).toBeNull();
    expect(await repo.accessRecords.list()).toEqual(committed);
  });

  test('partial and cross-boundary reorder snapshots leave every row untouched', async () => {
    const repo = await makeRepo();
    const principal = { kind: 'user' as const, id: 2 };
    const first = await repo.accessRecords.save({ principal, scope: { kind: 'upstreamModel', upstreamId: 'up_a', model: { kind: 'regex', value: '^gpt' } }, sortOrder: 0, values: { 'Model.Use': false } });
    const second = await repo.accessRecords.save({ principal, scope: { kind: 'upstreamModel', upstreamId: 'up_a', model: { kind: 'exact', value: 'gpt-5' } }, sortOrder: 1, values: { 'Model.Use': true } });
    const fixed = await repo.accessRecords.save({ principal, scope: { kind: 'upstream', upstreamId: 'up_a' }, sortOrder: 0, values: { 'Model.Use': true } });
    const other = await repo.accessRecords.save({ principal, scope: { kind: 'upstreamModel', upstreamId: 'up_b', model: { kind: 'exact', value: 'gpt-5' } }, sortOrder: 0, values: { 'Model.Use': true } });
    const before = await repo.accessRecords.list();
    for (const expected of [[first.id], [first.id, second.id, fixed.id], [first.id, other.id]]) {
      expect(await repo.accessRecords.reorderModel('up_a', expected, expected.toReversed())).toBeNull();
      expect(await repo.accessRecords.list()).toEqual(before);
    }
  });
});
