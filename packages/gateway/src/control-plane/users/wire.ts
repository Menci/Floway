import type { User } from '../../repo/types.ts';

export interface SessionCapabilities {
  canViewPermissions: boolean;
  canViewUpstreams: boolean;
}

// The self-description returned by /auth/login and /auth/me. Access to
// upstreams is expressed as ACL rules, so this carries only the dashboard
// surfaces the account may open.
export const userToSessionWire = (user: User, capabilities: SessionCapabilities) => ({
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
