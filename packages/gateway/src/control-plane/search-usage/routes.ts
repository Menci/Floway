// GET /api/search-usage — query per-key or per-user web search usage records.
//
// Mirrors the token-usage endpoint: the `view` query parameter selects between
// `self-by-key` (the actor's own keys) and `all-by-user` (cross-user aggregate
// for callers with `canViewGlobalTelemetry`). Default view is determined by
// capability.

import { aggregateSearchUsageByKey, aggregateSearchUsageByUser } from './aggregate.ts';
import { loadSearchConfig } from '../../data-plane/tools/web-search/search-config.ts';
import { queryWebSearchUsage } from '../../data-plane/tools/web-search/usage.ts';
import { type CtxWithQuery } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import { isWebSearchProviderName } from '../../shared/web-search-providers.ts';
import type { searchUsageQuery } from '../schemas.ts';
import { loadTelemetryKeys, resolveTelemetryView } from '../telemetry-view.ts';

export const searchUsage = async (c: CtxWithQuery<typeof searchUsageQuery>) => {
  const query = c.req.valid('query');
  if (!query.start || !query.end) {
    return c.json({ error: 'start and end query parameters are required (e.g. 2026-03-09T00)' }, 400);
  }
  const { start, end } = query;

  const { provider } = query;
  if (provider !== undefined && !isWebSearchProviderName(provider)) {
    return c.json({ error: "provider must be 'tavily' or 'microsoft-grounding'" }, 400);
  }

  const resolved = resolveTelemetryView(c, query.view, query.key_id);
  if ('error' in resolved) {
    return c.json({ error: resolved.message }, resolved.error === 'forbidden' ? 403 : 400);
  }

  const repo = getRepo();

  if (resolved.view === 'all-by-user') {
    const [rawRecords, users, keysInfo] = await Promise.all([
      queryWebSearchUsage({ provider, start, end }),
      repo.users.listIncludingDeleted(),
      loadTelemetryKeys(repo, resolved),
    ]);
    const records = aggregateSearchUsageByUser(rawRecords, keysInfo.keyToUser);

    if (query.include_user_metadata !== '1') return c.json(records);
    const userMetadata = users
      .map(u => ({ id: u.id, username: u.username }))
      .sort((a, b) => a.id - b.id);
    const searchConfig = await loadSearchConfig();
    return c.json({
      records,
      users: userMetadata,
      activeProvider: searchConfig.provider,
    });
  }

  // self-view: scope rows to the actor's keys (active + soft-deleted).
  // One api_keys listing feeds both the ownedSet gate and — when
  // include_key_metadata=1 asks for it — the sorted keys[] block below.
  const keysInfo = await loadTelemetryKeys(repo, resolved);
  const ownedSet = new Set(keysInfo.keys.map(k => k.id));
  const explicitKeyId = query.key_id === '' ? undefined : query.key_id;
  if (explicitKeyId !== undefined && !ownedSet.has(explicitKeyId)) {
    return c.json({ error: 'Unknown key_id' }, 404);
  }

  const rawRecords = await queryWebSearchUsage({
    provider,
    keyId: explicitKeyId,
    start,
    end,
  });
  const filtered = explicitKeyId ? rawRecords : rawRecords.filter(r => ownedSet.has(r.keyId));
  const aggregated = aggregateSearchUsageByKey(filtered);

  // Aggregated-records-only callers (CI, automation) skip the
  // sorted key-metadata block via include_key_metadata=0.
  if (query.include_key_metadata !== '1') return c.json(aggregated);

  const searchConfig = await loadSearchConfig();
  const keyMap = new Map(keysInfo.keys.map(k => [k.id, k]));
  const recordsWithKeyMetadata = aggregated.map(r => {
    const k = keyMap.get(r.keyId);
    if (!k) throw new Error(`telemetry row references unknown key ${r.keyId} for user ${resolved.scopeUserId}`);
    return { ...r, keyName: k.name, keyCreatedAt: k.createdAt };
  });
  const keyMetadata = keysInfo.keys.map(k => ({ id: k.id, name: k.name, createdAt: k.createdAt })).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));

  return c.json({
    records: recordsWithKeyMetadata,
    keys: keyMetadata,
    activeProvider: searchConfig.provider,
  });
};
