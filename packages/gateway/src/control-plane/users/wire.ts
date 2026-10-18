import type { User } from '../../repo/types.ts';

export const userToSessionWire = (user: User, canViewUpstreams: boolean) => ({
  id: user.id,
  username: user.username,
  isAdmin: user.isAdmin,
  canViewUpstreams,
});

export const userToAdminWire = (user: User, groupIds: readonly number[], accessRecordCount: number) => ({
  id: user.id,
  username: user.username,
  isAdmin: user.isAdmin,
  groupIds,
  accessRecordCount,
  createdAt: user.createdAt,
});
