import type { User } from '../../repo/types.ts';

export const userToSessionWire = (user: User) => ({
  id: user.id,
  username: user.username,
  isAdmin: user.isAdmin,
});

export const userToAdminWire = (user: User) => ({
  ...userToSessionWire(user),
  createdAt: user.createdAt,
});
