import { expect, test } from 'vitest';

import type { ControlPlaneUserDirectory } from '../../../src/api/types';
import { indexUserDirectory } from '../../../src/components/users/directory';

const directory: ControlPlaneUserDirectory = {
  users: [
    { id: 1, username: 'alice', isAdmin: true, createdAt: '2026-01-01T00:00:00Z', preferences: { quotaDisplay: 'remaining', language: null } },
    { id: 2, username: 'bob', isAdmin: false, createdAt: '2026-01-02T00:00:00Z', preferences: { quotaDisplay: 'remaining', language: null } },
  ],
  groups: [
    { id: 1, name: 'Platform', hue: 210, createdAt: '2026-01-01T00:00:00Z', deletedAt: null },
    { id: 2, name: 'Empty', hue: 120, createdAt: '2026-01-01T00:00:00Z', deletedAt: null },
  ],
  memberships: [{ groupId: 1, userId: 1, createdAt: '2026-02-01T12:00:00Z' }],
};

test('derives both membership directions and picker counts from one relation list', () => {
  const index = indexUserDirectory(directory);
  expect(index.groupsByUser.get(1)).toEqual([directory.groups[0]]);
  expect(index.groupsByUser.get(1)![0]).toBe(directory.groups[0]);
  expect(index.membersByGroup.get(1)).toEqual([{ user: directory.users[0], createdAt: directory.memberships[0]!.createdAt }]);
  expect(index.membersByGroup.get(1)![0]!.user).toBe(directory.users[0]);
  expect(index.groupOptions).toEqual([
    { id: 1, name: 'Platform', hue: 210, memberCount: 1 },
    { id: 2, name: 'Empty', hue: 120, memberCount: 0 },
  ]);
});

test('indexes isolated entities and an empty directory without synthesized relations', () => {
  const index = indexUserDirectory(directory);
  expect(index.groupsByUser.get(2)).toEqual([]);
  expect(index.membersByGroup.get(2)).toEqual([]);
  const empty = indexUserDirectory({ users: [], groups: [], memberships: [] });
  expect(empty.groupsByUser.size).toBe(0);
  expect(empty.membersByGroup.size).toBe(0);
  expect(empty.groupOptions).toEqual([]);
});
