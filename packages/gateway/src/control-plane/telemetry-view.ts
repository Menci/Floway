import { type AuthedContext, userFromContext } from '../middleware/auth.ts';
import type { ApiKey, Repo } from '../repo/types.ts';

// The two shapes the usage endpoints answer in. Performance carries no view:
// its scope follows the requested breakdown instead.
export type TelemetryView = 'all-by-user' | 'self-by-key';

// Discriminated union so callers narrow scopeUserId without non-null assertions.
export type ResolvedTelemetryView =
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

export const loadTelemetryKeys = async (
  repo: Repo,
  resolved: ResolvedTelemetryView,
): Promise<readonly ApiKey[]> => resolved.view === 'all-by-user'
  ? await repo.apiKeys.listIncludingDeleted()
  : await repo.apiKeys.listByUserIdIncludingDeleted(resolved.scopeUserId);

// Only callers that fan telemetry rows out across users (all-by-user usage,
// or performance's cross-cutting group_by=userId) need this map. self-by-key
// callers pay nothing since every row's user is fixed by construction.
export const buildKeyToUserMap = (
  keys: readonly ApiKey[],
): ReadonlyMap<string, number> => new Map(keys.map(k => [k.id, k.userId] as const));
