import { beforeEach, describe, expect, test, vi } from 'vitest';

import { check, checkMany } from '../../src/access-control/check.ts';
import { initRepo } from '../../src/repo/index.ts';
import type { User } from '../../src/repo/types.ts';
import { InMemoryRepo } from '../repo/memory.ts';

const subject: User = {
  id: 2,
  username: 'alice',
  passwordHash: null,
  isAdmin: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  deletedAt: null,
};

let repo: InMemoryRepo;

beforeEach(() => {
  repo = new InMemoryRepo();
  initRepo(repo);
});

test('deeper explicit values replace shallower values per permission', async () => {
  await repo.accessRecords.save({
    principal: { kind: 'user', id: subject.id },
    scope: { kind: 'upstreams' },
    sortOrder: 0,
    values: { 'Model.Use': true, 'Upstream.Audit': true },
  });
  await repo.accessRecords.save({
    principal: { kind: 'user', id: subject.id },
    scope: { kind: 'upstream', upstreamId: 'up_a' },
    sortOrder: 0,
    values: { 'Model.Use': false },
  });

  expect(await check(subject, { kind: 'upstreamModel', upstreamId: 'up_a', modelId: 'gpt-5' }, { permission: 'Model.Use' })).toBe(false);
  expect(await check(subject, { kind: 'upstream', upstreamId: 'up_a' }, { permission: 'Upstream.Audit' })).toBe(true);
  expect(await check(subject, { kind: 'upstreamModel', upstreamId: 'up_b', modelId: 'gpt-5' }, { permission: 'Model.Use' })).toBe(true);
});

test('same-depth model patterns use sortOrder without an implicit exact priority', async () => {
  await repo.accessRecords.save({
    principal: { kind: 'user', id: subject.id },
    scope: { kind: 'upstreamModel', upstreamId: 'up_a', model: { kind: 'regex', value: '^gpt-[45]$' } },
    sortOrder: 0,
    values: { 'Model.Use': false },
  });
  await repo.accessRecords.save({
    principal: { kind: 'user', id: subject.id },
    scope: { kind: 'upstreamModel', upstreamId: 'up_a', model: { kind: 'exact', value: 'gpt-5' } },
    sortOrder: 1,
    values: { 'Model.Use': true },
  });

  expect(await check(subject, { kind: 'upstreamModel', upstreamId: 'up_a', modelId: 'gpt-5' }, { permission: 'Model.Use' })).toBe(false);
});

test('direct and group principals combine by the highest permission', async () => {
  const grantingGroup = await repo.groups.create('operators', 120);
  await repo.groups.replaceMembers(grantingGroup.id, [subject.id]);
  await repo.accessRecords.save({
    principal: { kind: 'user', id: subject.id },
    scope: { kind: 'upstream', upstreamId: 'up_a' },
    sortOrder: 0,
    values: { 'Model.Use': false },
  });
  await repo.accessRecords.save({
    principal: { kind: 'group', id: grantingGroup.id },
    scope: { kind: 'upstream', upstreamId: 'up_a' },
    sortOrder: 0,
    values: { 'Model.Use': true },
  });

  expect(await check(subject, { kind: 'upstream', upstreamId: 'up_a' }, { permission: 'Model.Use' })).toBe(true);
});

test('a Group scope expands to its current members for User.Audit', async () => {
  const targetGroup = await repo.groups.create('team', 120);
  await repo.groups.replaceMembers(targetGroup.id, [7]);
  await repo.accessRecords.save({
    principal: { kind: 'user', id: subject.id },
    scope: { kind: 'group', groupId: targetGroup.id },
    sortOrder: 0,
    values: { 'User.Audit': true },
  });

  expect(await check(subject, { kind: 'user', userId: 7 }, { permission: 'User.Audit' })).toBe(true);
  expect(await check(subject, { kind: 'user', userId: 8 }, { permission: 'User.Audit' })).toBe(false);
});

test('Upstream.Edit levels compare against the requested minimum', async () => {
  await repo.accessRecords.save({
    principal: { kind: 'user', id: subject.id },
    scope: { kind: 'upstream', upstreamId: 'up_a' },
    sortOrder: 0,
    values: { 'Upstream.Edit': 'models' },
  });

  expect(await check(subject, { kind: 'upstream', upstreamId: 'up_a' }, { permission: 'Upstream.Edit', level: 'models' })).toBe(true);
  expect(await check(subject, { kind: 'upstream', upstreamId: 'up_a' }, { permission: 'Upstream.Edit', level: 'full' })).toBe(false);
});

test('invalid target and permission combinations throw even for admins', async () => {
  await expect(check({ ...subject, isAdmin: true }, { kind: 'user', userId: 7 }, { permission: 'Model.Use' })).rejects.toThrow();
});

describe('read lifetime', () => {
  test('checkMany reads each source once for the whole call', async () => {
    const records = vi.spyOn(repo.accessRecords, 'listByPrincipals');
    const subjectGroups = vi.spyOn(repo.groups, 'listIdsByUserId');
    const targetGroups = vi.spyOn(repo.groups, 'listIdsByUserIds');

    await checkMany(subject, [
      { target: { kind: 'upstream', upstreamId: 'up_a' }, requirement: { permission: 'Model.Use' } },
      { target: { kind: 'user', userId: 7 }, requirement: { permission: 'User.Audit' } },
    ]);

    expect(records).toHaveBeenCalledOnce();
    expect(subjectGroups).toHaveBeenCalledOnce();
    expect(targetGroups).toHaveBeenCalledOnce();
  });

  test('separate calls observe permission changes immediately', async () => {
    await repo.accessRecords.save({
      principal: { kind: 'user', id: subject.id },
      scope: { kind: 'upstream', upstreamId: 'up_a' },
      sortOrder: 0,
      values: { 'Model.Use': true },
    });
    expect(await check(subject, { kind: 'upstream', upstreamId: 'up_a' }, { permission: 'Model.Use' })).toBe(true);
    await repo.accessRecords.save({
      principal: { kind: 'user', id: subject.id },
      scope: { kind: 'upstream', upstreamId: 'up_a' },
      sortOrder: 0,
      values: { 'Model.Use': false },
    });
    expect(await check(subject, { kind: 'upstream', upstreamId: 'up_a' }, { permission: 'Model.Use' })).toBe(false);
  });

  test('admin bypass stays inside check and performs no repository reads', async () => {
    const records = vi.spyOn(repo.accessRecords, 'listByPrincipals');
    expect(await check({ ...subject, isAdmin: true }, { kind: 'upstream', upstreamId: 'up_a' }, { permission: 'Model.Use' })).toBe(true);
    expect(records).not.toHaveBeenCalled();
  });
});
