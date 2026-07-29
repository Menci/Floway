// GET /api/search-usage — query per-key or per-user web search usage records.
//
// Mirrors the token-usage endpoint: the required `view` query parameter selects
// between `self-by-key` (the actor's own keys) and `all-by-user` (cross-user
// aggregate, administrators only).

import { aggregateWebSearchUsageByKey, aggregateWebSearchUsageByUser } from './aggregate.ts';
import { type CtxWithQuery } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import { WEB_SEARCH_PROVIDER_NAMES, isWebSearchProviderName } from '../../shared/web-search-providers.ts';
import type { webSearchUsageQuery } from '../schemas.ts';
import { buildKeyToUserMap } from '../shared/key-to-user.ts';
import { resolveUsageView } from '../shared/usage-view.ts';
import type { SearchUsageByKeyResponse, SearchUsageByUserResponse } from '../usage-types.ts';

export const webSearchUsage = async (c: CtxWithQuery<typeof webSearchUsageQuery>) => {
  const query = c.req.valid('query');
  if (!query.start || !query.end) {
    return c.json({ error: 'start and end query parameters are required (e.g. 2026-03-09T00)' }, 400);
  }
  const { start, end } = query;

  const { provider } = query;
  if (provider !== undefined && !isWebSearchProviderName(provider)) {
    return c.json({ error: `provider must be one of ${WEB_SEARCH_PROVIDER_NAMES.map(name => `'${name}'`).join(', ')}` }, 400);
  }

  const resolved = resolveUsageView(c, query.view, query.key_id);
  if ('error' in resolved) {
    return c.json({ error: resolved.message }, resolved.error === 'forbidden' ? 403 : 400);
  }

  const repo = getRepo();

  if (resolved.view === 'all-by-user') {
    const [rawRecords, users, keys] = await Promise.all([
      repo.webSearchUsage.query({ provider, start, end }),
      repo.users.listIncludingDeleted(),
      repo.apiKeys.listIncludingDeleted(),
    ]);
    const records = aggregateWebSearchUsageByUser(rawRecords, buildKeyToUserMap(keys));

    if (query.include_user_metadata !== '1') return c.json(records);
    const userMetadata = users
      .map(u => ({ id: u.id, username: u.username }))
      .sort((a, b) => a.id - b.id);
    return c.json({
      view: 'all-by-user',
      records,
      users: userMetadata,
    } satisfies SearchUsageByUserResponse);
  }

  // self-by-key: scope rows to the actor's keys (active + soft-deleted).
  const keys = await repo.apiKeys.listByUserIdIncludingDeleted(resolved.scopeUserId);
  const ownedSet = new Set(keys.map(k => k.id));
  const explicitKeyId = query.key_id === '' ? undefined : query.key_id;
  if (explicitKeyId !== undefined && !ownedSet.has(explicitKeyId)) {
    return c.json({ error: 'Unknown key_id' }, 404);
  }

  const rawRecords = await repo.webSearchUsage.query({
    provider,
    keyId: explicitKeyId,
    start,
    end,
  });
  const filtered = explicitKeyId ? rawRecords : rawRecords.filter(r => ownedSet.has(r.keyId));
  const aggregated = aggregateWebSearchUsageByKey(filtered);

  // Aggregated-records-only callers (CI, automation) skip the sorted
  // key-name/createdAt block via include_key_metadata=0.
  // The api_keys listing above still runs — it gates ownership on the raw
  // rows and cannot be elided.
  if (query.include_key_metadata !== '1') return c.json(aggregated);

  const keyMap = new Map(keys.map(k => [k.id, k]));
  const recordsWithKeyMetadata = aggregated.map(r => {
    const k = keyMap.get(r.keyId);
    if (!k) throw new Error(`telemetry row references unknown key ${r.keyId} for user ${resolved.scopeUserId}`);
    return { ...r, keyName: k.name, keyCreatedAt: k.createdAt };
  });
  const keyMetadata = keys.map(k => ({ id: k.id, name: k.name, createdAt: k.createdAt })).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));

  return c.json({
    view: 'self-by-key',
    records: recordsWithKeyMetadata,
    keys: keyMetadata,
  } satisfies SearchUsageByKeyResponse);
};
