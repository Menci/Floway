import { type AuthedContext, canViewGlobalTelemetry, userFromContext } from '../middleware/auth.ts';
import type { ApiKey, Repo } from '../repo/types.ts';

export type TelemetryView = 'all-by-user' | 'self-by-key';

// Discriminated union so callers narrow scopeUserId without non-null assertions.
export type ResolvedTelemetryView =
  | { view: 'self-by-key'; scopeUserId: number }
  | { view: 'all-by-user' };

export const resolveTelemetryView = (
  c: AuthedContext,
  rawView: TelemetryView | undefined,
  rawKeyId: string | undefined,
): ResolvedTelemetryView | { error: 'forbidden' | 'bad_request'; message: string } => {
  const user = userFromContext(c);
  const canViewGlobal = canViewGlobalTelemetry(user);

  const view = rawView ?? (canViewGlobal ? 'all-by-user' : 'self-by-key');

  if (view === 'all-by-user' && !canViewGlobal) {
    return {
      error: 'forbidden',
      message: 'You do not have permission to view global telemetry',
    };
  }
  if (view === 'all-by-user' && rawKeyId !== undefined && rawKeyId !== '') {
    return {
      error: 'bad_request',
      message: 'key_id is not allowed in all-by-user mode',
    };
  }

  return view === 'self-by-key'
    ? { view: 'self-by-key', scopeUserId: user.id }
    : { view: 'all-by-user' };
};

// Every telemetry endpoint (token-usage, search-usage, performance) needs
// the api_keys row set that corresponds to the resolved view — the same
// listing feeds both the key→user map (used by cross-user aggregation) and
// the sorted key-metadata block (used by dashboard rendering). Sharing this
// helper keeps the two derivations in lockstep and avoids the historic
// pattern of fetching the table twice in the same handler.
export const loadTelemetryKeys = async (
  repo: Repo,
  resolved: ResolvedTelemetryView,
): Promise<{ keyToUser: ReadonlyMap<string, number>; keys: readonly ApiKey[] }> => {
  const keys = resolved.view === 'all-by-user'
    ? await repo.apiKeys.listIncludingDeleted()
    : await repo.apiKeys.listByUserIdIncludingDeleted(resolved.scopeUserId);
  return { keyToUser: new Map(keys.map(k => [k.id, k.userId] as const)), keys };
};
