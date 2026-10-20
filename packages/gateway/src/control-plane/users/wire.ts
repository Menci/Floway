import type { User } from '../../repo/types.ts';
import type { UserPreferences } from '@floway-dev/protocols/common';

export interface SessionCapabilities {
  canViewPermissions: boolean;
  canViewUpstreams: boolean;
}

// The self-description returned by /auth/login and /auth/me. Upstream access is
// expressed as ACL rules rather than a user-level cap, so this carries the
// dashboard surfaces the account may open on top of the shared account fields.
export const userToSessionWire = (
  user: User,
  capabilities: SessionCapabilities,
  preferences: UserPreferences,
) => ({
  id: user.id,
  username: user.username,
  isAdmin: user.isAdmin,
  preferences,
  ...capabilities,
});

// Admin listings describe accounts, not the caller's own capabilities, so they
// carry no session surface flags.
export const userToAdminWire = (
  user: User,
  groupIds: readonly number[],
  preferences: UserPreferences,
) => ({
  id: user.id,
  username: user.username,
  isAdmin: user.isAdmin,
  preferences,
  groupIds,
  createdAt: user.createdAt,
});
