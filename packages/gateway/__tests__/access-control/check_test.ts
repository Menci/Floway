import { beforeEach, expect, test, vi } from 'vitest';

import { checkMany } from '../../src/access-control/check.ts';
import type { AccessRequirement, AccessTarget } from '../../src/access-control/types.ts';
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

const check = async (subject: User, target: AccessTarget, requirement: AccessRequirement): Promise<boolean> =>
  (await checkMany(subject, [{ target, requirement }]))[0]!;

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

  expect(await check(subject, { kind: 'upstreamModel', upstreamId: 'up_a', model: { kind: 'exact', value: 'gpt-5' } }, { permission: 'Model.Use' })).toBe(false);
  expect(await check(subject, { kind: 'upstream', upstreamId: 'up_a' }, { permission: 'Upstream.Audit' })).toBe(true);
  expect(await check(subject, { kind: 'upstreamModel', upstreamId: 'up_b', model: { kind: 'exact', value: 'gpt-5' } }, { permission: 'Model.Use' })).toBe(true);
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

test('a user may always audit themselves without an ACL record', async () => {
  expect(await check(subject, { kind: 'user', userId: subject.id }, { permission: 'User.Audit' })).toBe(true);
  expect(await check(subject, { kind: 'user', userId: subject.id + 1 }, { permission: 'User.Audit' })).toBe(false);
});

test('Permission.Audit on a group does not expose its members', async () => {
  const targetGroup = await repo.groups.create('reviewed', 120);
  await repo.groups.replaceMembers(targetGroup.id, [7]);
  await repo.accessRecords.save({
    principal: { kind: 'user', id: subject.id },
    scope: { kind: 'group', groupId: targetGroup.id },
    sortOrder: 0,
    values: { 'Permission.Audit': true },
  });

  expect(await check(subject, { kind: 'group', groupId: targetGroup.id }, { permission: 'Permission.Audit' })).toBe(true);
  expect(await check(subject, { kind: 'user', userId: 7 }, { permission: 'Permission.Audit' })).toBe(false);
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

test('admin bypass stays inside check and performs no repository reads', async () => {
  const records = vi.spyOn(repo.accessRecords, 'listByPrincipals');
  expect(await check({ ...subject, isAdmin: true }, { kind: 'upstream', upstreamId: 'up_a' }, { permission: 'Model.Use' })).toBe(true);
  expect(records).not.toHaveBeenCalled();
});

test('a nonmatching exact model rule does not override an ancestor grant', async () => {
  await repo.accessRecords.save({
    principal: { kind: 'user', id: subject.id },
    scope: { kind: 'upstreams' },
    sortOrder: 0,
    values: { 'Model.Use': true },
  });
  await repo.accessRecords.save({
    principal: { kind: 'user', id: subject.id },
    scope: { kind: 'upstreamModel', upstreamId: 'up_a', model: { kind: 'exact', value: 'gpt-4' } },
    sortOrder: 0,
    values: { 'Model.Use': false },
  });
  expect(await checkMany(subject, [
    { target: { kind: 'upstreamModel', upstreamId: 'up_a', model: { kind: 'exact', value: 'gpt-5' } }, requirement: { permission: 'Model.Use' } },
  ])).toEqual([true]);
});
