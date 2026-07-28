import { type AuthedContext, userFromContext } from '../../middleware/auth.ts';
import { getRepo } from '../../repo/index.ts';
import type { ApiKey } from '../../repo/types.ts';

// Resolve an API key path-param and confirm the authenticated user owns it.
// A miss and foreign ownership both return null so callers expose the same
// 404 without leaking another user's key id.
export const ownedKeyForUser = async (c: AuthedContext, id: string): Promise<ApiKey | null> => {
  const userId = userFromContext(c).id;
  const key = await getRepo().apiKeys.getById(id);
  if (key?.userId !== userId) return null;
  return key;
};
