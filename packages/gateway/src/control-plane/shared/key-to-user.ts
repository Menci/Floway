import type { ApiKey } from '../../repo/types.ts';

// Usage and performance rows carry a key id, not a user id — this join
// attributes them to a user.
export const buildKeyToUserMap = (
  keys: readonly ApiKey[],
): ReadonlyMap<string, number> => new Map(keys.map(k => [k.id, k.userId] as const));
