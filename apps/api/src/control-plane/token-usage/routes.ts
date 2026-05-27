// GET /api/token-usage — query per-key token usage records
//
// IMPORTANT DESIGN DECISION: Usage data is intentionally readable by ALL authenticated
// users (both admin and API key users), without scoping. Any authenticated user can view
// usage records for all keys. API keys themselves are only readable by their owner.

import { aggregateUsageForDisplay } from './aggregate.ts';
import { type CtxWithQuery } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import type { tokenUsageQuery } from '../schemas.ts';
import { USAGE_KEY_COLOR_ORDER } from '../usage-key-colors.ts';

export const tokenUsage = async (c: CtxWithQuery<typeof tokenUsageQuery>) => {
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

  const repo = getRepo();
  const [rawRecords, keys] = await Promise.all([repo.usage.query({ keyId, start, end }), repo.apiKeys.list()]);
  const records = aggregateUsageForDisplay(rawRecords);

  const keyMap = new Map(keys.map(k => [k.id, k]));
  const recordsWithKeyMetadata = records.map(r => ({
    ...r,
    keyName: keyMap.get(r.keyId)?.name ?? r.keyId.slice(0, 8),
    keyCreatedAt: keyMap.get(r.keyId)?.createdAt ?? null,
  }));

  if (!includeKeyMetadata) return c.json(recordsWithKeyMetadata);

  const keyMetadata = keys.map(k => ({ id: k.id, name: k.name, createdAt: k.createdAt })).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return c.json({
    records: recordsWithKeyMetadata,
    keys: keyMetadata,
    keyColorOrder: USAGE_KEY_COLOR_ORDER,
  });
};
