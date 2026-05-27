// GET /api/search-usage — query per-key web search usage records
//
// Usage data mirrors token usage visibility: any authenticated user can view
// aggregate records and key metadata because the dashboard usage tab is shared.

import { loadSearchConfig } from '../../data-plane/tools/web-search/search-config.ts';
import { queryWebSearchUsage } from '../../data-plane/tools/web-search/usage.ts';
import { type CtxWithQuery } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import { isWebSearchProviderName, type WebSearchProviderName } from '../../shared/web-search-providers.ts';
import type { searchUsageQuery } from '../schemas.ts';
import { USAGE_KEY_COLOR_ORDER } from '../usage-key-colors.ts';

const parseProvider = (provider: string | undefined): { type: 'ok'; provider?: WebSearchProviderName } | { type: 'invalid' } => {
  if (provider === undefined) return { type: 'ok' };
  if (isWebSearchProviderName(provider)) {
    return { type: 'ok', provider };
  }
  return { type: 'invalid' };
};

export const searchUsage = async (c: CtxWithQuery<typeof searchUsageQuery>) => {
  const query = c.req.valid('query');
  const keyId = query.key_id === '' ? undefined : query.key_id;
  const start = query.start ?? '';
  const end = query.end ?? '';
  const includeKeyMetadata = query.include_key_metadata === '1';

  if (!start || !end) {
    return c.json(
      {
        error: 'start and end query parameters are required (e.g. 2026-03-09T00)',
      },
      400,
    );
  }

  const providerResult = parseProvider(query.provider);
  if (providerResult.type === 'invalid') {
    return c.json(
      {
        error: "provider must be 'tavily' or 'microsoft-grounding'",
      },
      400,
    );
  }

  const [records, keys] = await Promise.all([
    queryWebSearchUsage({
      provider: providerResult.provider,
      keyId,
      start,
      end,
    }),
    getRepo().apiKeys.list(),
  ]);

  const keyMap = new Map(keys.map(k => [k.id, k]));
  const recordsWithKeyMetadata = records.map(r => ({
    ...r,
    keyName: keyMap.get(r.keyId)?.name ?? r.keyId.slice(0, 8),
    keyCreatedAt: keyMap.get(r.keyId)?.createdAt ?? null,
  }));

  if (!includeKeyMetadata) return c.json(recordsWithKeyMetadata);

  const searchConfig = await loadSearchConfig();
  const keyMetadata = keys.map(k => ({ id: k.id, name: k.name, createdAt: k.createdAt })).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));

  return c.json({
    records: recordsWithKeyMetadata,
    keys: keyMetadata,
    keyColorOrder: USAGE_KEY_COLOR_ORDER,
    activeProvider: searchConfig.provider,
  });
};
