// GET /api/token-usage — query per-key or per-user usage records.
//
// The `view` query parameter selects between two shapes: `self-by-key` returns
// the actor's own keys, while `all-by-user` aggregates across users for admins
// and users granted the `canViewGlobalTelemetry` flag.

import { aggregateUsageByUserForDisplay, aggregateUsageForDisplay } from './aggregate.ts';
import { type CtxWithQuery } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import type { tokenUsageQuery } from '../schemas.ts';
import { buildKeyToUserMap, loadTelemetryKeys, resolveTelemetryView } from '../telemetry-view.ts';

export const tokenUsage = async (c: CtxWithQuery<typeof tokenUsageQuery>) => {
  const query = c.req.valid('query');
  if (!query.start || !query.end) {
    return c.json({ error: 'start and end query parameters are required (e.g. 2026-03-09T00)' }, 400);
  }
  const { start, end } = query;

  const resolved = resolveTelemetryView(c, query.view, query.key_id);
  if ('error' in resolved) {
    return c.json({ error: resolved.message }, resolved.error === 'forbidden' ? 403 : 400);
  }

  const repo = getRepo();

  if (resolved.view === 'all-by-user') {
    const [rawRecords, users, keys] = await Promise.all([
      repo.usage.query({ start, end }),
      repo.users.listIncludingDeleted(),
      loadTelemetryKeys(repo, resolved),
    ]);
    const records = aggregateUsageByUserForDisplay(rawRecords, buildKeyToUserMap(keys));

    if (query.include_user_metadata !== '1') return c.json(records);
    const userMetadata = users
      .map(u => ({ id: u.id, username: u.username }))
      .sort((a, b) => a.id - b.id);
    return c.json({ records, users: userMetadata });
  }

  // Sequential so an invalid key_id short-circuits to 404 before spending the usage.query read.
  const keys = await loadTelemetryKeys(repo, resolved);
  const ownedSet = new Set(keys.map(k => k.id));
  const explicitKeyId = query.key_id === '' ? undefined : query.key_id;
  if (explicitKeyId !== undefined && !ownedSet.has(explicitKeyId)) {
    return c.json({ error: 'Unknown key_id' }, 404);
  }

  const rawRecords = await repo.usage.query({ keyId: explicitKeyId, start, end });
  const filtered = explicitKeyId ? rawRecords : rawRecords.filter(r => ownedSet.has(r.keyId));
  const records = aggregateUsageForDisplay(filtered);

  const keyMap = new Map(keys.map(k => [k.id, k]));
  const recordsWithKeyMetadata = records.map(r => {
    const k = keyMap.get(r.keyId);
    if (!k) throw new Error(`telemetry row references unknown key ${r.keyId} for user ${resolved.scopeUserId}`);
    return { ...r, keyName: k.name, keyCreatedAt: k.createdAt };
  });

  if (query.include_key_metadata !== '1') return c.json(recordsWithKeyMetadata);

  const keyMetadata = keys
    .map(k => ({ id: k.id, name: k.name, createdAt: k.createdAt }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return c.json({
    records: recordsWithKeyMetadata,
    keys: keyMetadata,
  });
};
