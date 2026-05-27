import type { Context } from 'hono';

import { type CtxWithJson } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import type { ApiKey } from '../../repo/types.ts';
import type { createKeyBody, updateKeyBody } from '../schemas.ts';

const generateKey = (): string => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
};

const apiKeyToJson = (key: ApiKey) => ({
  id: key.id,
  name: key.name,
  key: key.key,
  created_at: key.createdAt,
  last_used_at: key.lastUsedAt ?? null,
  upstream_ids: key.upstreamIds,
});

export const listKeys = async (c: Context) => {
  const isAdmin = c.get('isAdmin');
  if (isAdmin) {
    const keys = await getRepo().apiKeys.list();
    return c.json(keys.map(k => apiKeyToJson(k)));
  }
  const keyId = c.get('apiKeyId') as string;
  const key = await getRepo().apiKeys.getById(keyId);
  return c.json(key ? [apiKeyToJson(key)] : []);
};

export const createKey = async (c: CtxWithJson<typeof createKeyBody>) => {
  const body = c.req.valid('json');
  const key = {
    id: crypto.randomUUID(),
    name: body.name,
    key: generateKey(),
    createdAt: new Date().toISOString(),
    upstreamIds: null,
  } satisfies ApiKey;
  await getRepo().apiKeys.save(key);
  return c.json(apiKeyToJson(key), 201);
};

export const deleteKey = async (c: Context) => {
  const id = c.req.param('id') ?? '';
  const deleted = await getRepo().apiKeys.delete(id);
  if (!deleted) return c.json({ error: 'Key not found' }, 404);
  return c.json({ ok: true });
};

export const rotateKey = async (c: Context) => {
  const id = c.req.param('id') ?? '';
  const repo = getRepo().apiKeys;
  const existing = await repo.getById(id);
  if (!existing) return c.json({ error: 'Key not found' }, 404);

  const updated = { ...existing, key: generateKey() } satisfies ApiKey;
  await repo.save(updated);
  return c.json(apiKeyToJson(updated));
};

export const updateKey = async (c: CtxWithJson<typeof updateKeyBody>) => {
  const id = c.req.param('id') ?? '';
  const body = c.req.valid('json');

  if (body.name === undefined && body.upstream_ids === undefined) {
    return c.json({ error: 'at least one of name or upstream_ids must be provided' }, 400);
  }

  // Schema enforces format and uniqueness; the only remaining domain check
  // is that every referenced upstream id actually exists.
  if (body.upstream_ids != null) {
    const upstreams = await getRepo().upstreams.list();
    const knownIds = new Set(upstreams.map(u => u.id));
    const unknown = body.upstream_ids.filter(uid => !knownIds.has(uid));
    if (unknown.length > 0) return c.json({ error: `unknown upstream id(s): ${unknown.join(', ')}` }, 400);
  }

  const repo = getRepo().apiKeys;
  const existing = await repo.getById(id);
  if (!existing) return c.json({ error: 'Key not found' }, 404);

  const updated: ApiKey = {
    ...existing,
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.upstream_ids !== undefined ? { upstreamIds: body.upstream_ids } : {}),
  };
  await repo.save(updated);
  return c.json(apiKeyToJson(updated));
};
