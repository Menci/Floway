import type { User } from '../../repo/types.ts';

export const userToSessionWire = (user: User, capabilities: { canViewPermissions: boolean; canViewUpstreams: boolean }) => ({
  id: user.id,
  username: user.username,
  isAdmin: user.isAdmin,
  ...capabilities,
});

export const userToAdminWire = (user: User, groupIds: readonly number[]) => ({
  id: user.id,
  username: user.username,
  isAdmin: user.isAdmin,
  groupIds,
  createdAt: user.createdAt,
});
