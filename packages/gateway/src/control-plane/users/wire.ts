import type { User } from '../../repo/types.ts';
import { pruneUnreachableUpstreamIds } from '../shared/upstream-ids.ts';

// The self-description returned by /auth/login and /auth/me. The live upstream
// catalog is a required argument rather than an optional one so a new caller
// cannot forget it and emit a cap the write path would refuse to take back.
export const userToSessionWire = (user: User, knownUpstreamIds: ReadonlySet<string>) => ({
  id: user.id,
  username: user.username,
  isAdmin: user.isAdmin,
  upstreamIds: pruneUnreachableUpstreamIds(user.upstreamIds, knownUpstreamIds),
});

export const userToAdminWire = (user: User, knownUpstreamIds: ReadonlySet<string>) => ({
  ...userToSessionWire(user, knownUpstreamIds),
  createdAt: user.createdAt,
});
