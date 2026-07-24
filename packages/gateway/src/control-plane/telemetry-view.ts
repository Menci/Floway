import { type AuthedContext, userFromContext } from '../middleware/auth.ts';
import type { ApiKey } from '../repo/types.ts';

// The two shapes the usage endpoints answer in.
type TelemetryView = 'all-by-user' | 'self-by-key';

// Discriminated union so callers narrow scopeUserId without non-null assertions.
type ResolvedTelemetryView =
  | { view: 'self-by-key'; scopeUserId: number }
  | { view: 'all-by-user' };

export const resolveTelemetryView = (
  c: AuthedContext,
  view: TelemetryView,
  rawKeyId: string | undefined,
): ResolvedTelemetryView | { error: 'forbidden' | 'bad_request'; message: string } => {
  const user = userFromContext(c);

  if (view === 'self-by-key') return { view: 'self-by-key', scopeUserId: user.id };

  // Cross-user usage exposes other users' request volume and spend.
  if (!user.isAdmin) {
    return {
      error: 'forbidden',
      message: 'Viewing usage across users requires administrator privileges',
    };
  }
  if (rawKeyId !== undefined && rawKeyId !== '') {
    return {
      error: 'bad_request',
      message: 'key_id is not allowed in all-by-user mode',
    };
  }
  return { view: 'all-by-user' };
};

// Telemetry rows carry a key id, not a user id — this is the join that
// attributes them to a user.
export const buildKeyToUserMap = (
  keys: readonly ApiKey[],
): ReadonlyMap<string, number> => new Map(keys.map(k => [k.id, k.userId] as const));
