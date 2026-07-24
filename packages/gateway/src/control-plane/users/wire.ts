import type { User } from '../../repo/types.ts';

// The self-description returned by /auth/login and /auth/me.
export const userToSessionWire = (user: User) => ({
  id: user.id,
  username: user.username,
  isAdmin: user.isAdmin,
  upstreamIds: user.upstreamIds,
});

export const userToAdminWire = (user: User) => ({
  ...userToSessionWire(user),
  createdAt: user.createdAt,
});
