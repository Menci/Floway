import type { User } from '../../repo/types.ts';
import { canViewGlobalTelemetry } from '../telemetry-view.ts';

// The effective shape reports what the actor may actually see. The stored flag
// only reaches performance, so that is the capability projected here; global
// usage follows `isAdmin`, which the dashboard reads directly.
export const userToEffectiveWire = (user: User) => ({
  id: user.id,
  username: user.username,
  isAdmin: user.isAdmin,
  canViewGlobalTelemetry: canViewGlobalTelemetry(user, 'performance'),
  upstreamIds: user.upstreamIds,
});

export const userToRawWire = (user: User) => ({
  id: user.id,
  username: user.username,
  isAdmin: user.isAdmin,
  canViewGlobalTelemetry: user.canViewGlobalTelemetry,
  upstreamIds: user.upstreamIds,
  createdAt: user.createdAt,
});
