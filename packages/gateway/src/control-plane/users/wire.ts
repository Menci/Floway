import type { User } from '../../repo/types.ts';

// What an authenticated actor is told about itself on login and /auth/me:
// identity plus the two facts the dashboard branches on.
export const userToSessionWire = (user: User) => ({
  id: user.id,
  username: user.username,
  isAdmin: user.isAdmin,
  upstreamIds: user.upstreamIds,
});

// The admin user-management listing row — the session shape plus the account's
// creation time, which only that table shows.
export const userToAdminWire = (user: User) => ({
  ...userToSessionWire(user),
  createdAt: user.createdAt,
});
