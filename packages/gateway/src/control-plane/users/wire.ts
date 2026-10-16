import type { User } from '../../repo/types.ts';

export const userToSessionWire = (user: User) => ({
  id: user.id,
  username: user.username,
  isAdmin: user.isAdmin,
});

export const userToAdminWire = (user: User, groupIds: readonly number[], accessRecordCount: number) => ({
  ...userToSessionWire(user),
  groupIds,
  accessRecordCount,
  createdAt: user.createdAt,
});
