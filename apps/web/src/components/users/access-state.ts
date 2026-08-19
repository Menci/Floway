import type { ControlPlaneUser } from '../../api/types';
import type { UpstreamAccessState } from '../upstreams/access-control';

export const batchUpstreamAccessStates = (
  users: readonly ControlPlaneUser[],
  upstreamIds: readonly string[],
): Map<string, UpstreamAccessState> => new Map(upstreamIds.map(upstreamId => {
  const allowed = users.map(user => user.upstreamIds === null || user.upstreamIds.includes(upstreamId));
  const state = allowed.every(Boolean) ? true : allowed.some(Boolean) ? 'mixed' : false;
  return [upstreamId, state];
}));

export const updateBatchUpstreamAccessChanges = (
  initialStates: ReadonlyMap<string, UpstreamAccessState>,
  changes: ReadonlyMap<string, boolean>,
  upstreamId: string,
  allowed: boolean,
): Map<string, boolean> => {
  const next = new Map(changes);
  if (initialStates.get(upstreamId) === allowed) next.delete(upstreamId);
  else next.set(upstreamId, allowed);
  return next;
};
