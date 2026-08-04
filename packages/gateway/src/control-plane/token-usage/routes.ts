// GET /api/token-usage — query per-key or per-user usage records.
//
// The required `view` query parameter selects between two shapes: `self-by-key`
// returns the actor's own keys, while `all-by-user` aggregates across users and
// is reserved for administrators.

import { aggregateUsageByUserForDashboard, aggregateUsageByUserForDisplay, aggregateUsageForDashboard, aggregateUsageForDisplay } from './aggregate.ts';
import { type CtxWithQuery } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import type { tokenUsageQuery } from '../schemas.ts';
import { buildKeyToUserMap } from '../shared/key-to-user.ts';
import { resolveUsageView } from '../shared/usage-view.ts';
import type { DashboardTokenUsageByKeyResponse, DashboardTokenUsageByUserResponse, TokenUsageByKeyResponse, TokenUsageByUserResponse } from '../usage-types.ts';

export const tokenUsage = async (c: CtxWithQuery<typeof tokenUsageQuery>) => {
  const query = c.req.valid('query');
  if (!query.start || !query.end) {
    return c.json({ error: 'start and end query parameters are required (e.g. 2026-03-09T00)' }, 400);
  }
  const { start, end } = query;

  const resolved = resolveUsageView(c, query.view, query.key_id);
  if ('error' in resolved) {
    return c.json({ error: resolved.message }, resolved.error === 'forbidden' ? 403 : 400);
  }

  const repo = getRepo();

  if (resolved.view === 'all-by-user') {
    const [rawRecords, users, keys] = await Promise.all([
      repo.usage.query({ start, end }),
      repo.users.listIncludingDeleted(),
      repo.apiKeys.listIncludingDeleted(),
    ]);
    const keyToUser = buildKeyToUserMap(keys);
    if (query.include_user_metadata !== '1') {
      return c.json(aggregateUsageByUserForDisplay(rawRecords, keyToUser));
    }
    const userMetadata = users
      .map(u => ({ id: u.id, username: u.username }))
      .sort((a, b) => a.id - b.id);
    if (query.include_upstream_dimension === '1') {
      const records = aggregateUsageByUserForDashboard(rawRecords, keyToUser);
      return c.json({ view: 'all-by-user', dimensions: ['upstream'], records, users: userMetadata } satisfies DashboardTokenUsageByUserResponse);
    }
    const records = aggregateUsageByUserForDisplay(rawRecords, keyToUser);
    return c.json({ view: 'all-by-user', records, users: userMetadata } satisfies TokenUsageByUserResponse);
  }

  // Sequential so an invalid key_id short-circuits to 404 before spending the usage.query read.
  const keys = await repo.apiKeys.listByUserIdIncludingDeleted(resolved.scopeUserId);
  const ownedSet = new Set(keys.map(k => k.id));
  const explicitKeyId = query.key_id === '' ? undefined : query.key_id;
  if (explicitKeyId !== undefined && !ownedSet.has(explicitKeyId)) {
    return c.json({ error: 'Unknown key_id' }, 404);
  }

  const rawRecords = await repo.usage.query({ keyId: explicitKeyId, start, end });
  const filtered = explicitKeyId ? rawRecords : rawRecords.filter(r => ownedSet.has(r.keyId));
  const keyMap = new Map(keys.map(k => [k.id, k]));
  const withKeyMetadata = <Record extends { keyId: string }>(records: Record[]) => records.map(r => {
      const k = keyMap.get(r.keyId);
      if (!k) throw new Error(`telemetry row references unknown key ${r.keyId} for user ${resolved.scopeUserId}`);
      return { ...r, keyName: k.name, keyCreatedAt: k.createdAt };
    });
  if (query.include_key_metadata !== '1') {
    return c.json(withKeyMetadata(aggregateUsageForDisplay(filtered)));
  }

  const keyMetadata = keys
    .map(k => ({ id: k.id, name: k.name, createdAt: k.createdAt }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  if (query.include_upstream_dimension === '1') {
    const records = withKeyMetadata(aggregateUsageForDashboard(filtered));
    return c.json({
      view: 'self-by-key',
      dimensions: ['upstream'],
      records,
      keys: keyMetadata,
    } satisfies DashboardTokenUsageByKeyResponse);
  }
  const records = withKeyMetadata(aggregateUsageForDisplay(filtered));
  return c.json({
    view: 'self-by-key',
    records,
    keys: keyMetadata,
  } satisfies TokenUsageByKeyResponse);
};
