import type { Context } from 'hono';
import { Hono } from 'hono';
import { z } from 'zod';

import { ownedKeyForUser } from './shared/owned-key.ts';
import { getDumpArchiveStore } from '../dump/registry.ts';
import { zValidator } from '../middleware/zod-validator.ts';

const LIST_LIMIT_DEFAULT = 100;
const LIST_LIMIT_MAX = 200;

const listQuery = z.object({
  // A coercion turns an absent key into a value, so only a present one is coerced.
  // https://github.com/colinhacks/zod/issues/6236
  limit: z.preprocess(value => value === undefined ? undefined : Number(value), z.number().int().positive().max(LIST_LIMIT_MAX)).exactOptional(),
  before: z.string().min(1).exactOptional(),
  q: z.string().trim().max(200).exactOptional(),
  failures: z.enum(['true', 'false']).exactOptional(),
});

const ownedKey = async (c: Context): Promise<{ id: string; error: null } | { id: null; error: string }> => {
  const keyId = c.req.param('keyId')!;
  const owned = await ownedKeyForUser(c, keyId);
  if (!owned) return { id: null, error: 'Key not found' };
  if (owned.dumpRetentionSeconds === null) {
    return { id: null, error: 'Dump capture is not enabled for this key.' };
  }
  return { id: owned.id, error: null };
};

export const dumpRoutes = new Hono()
  .get('/keys/:keyId/records', zValidator('query', listQuery), async c => {
    const owned = await ownedKey(c);
    if (owned.id === null) return c.json({ error: owned.error }, 404);
    const { limit, before, q, failures } = c.req.valid('query');
    const records = await getDumpArchiveStore().list(owned.id, {
      limit: limit ?? LIST_LIMIT_DEFAULT,
      q, failures: failures === 'true',
      ...(before !== undefined ? { before } : {}),
    });
    return c.json({ records });
  })
  .get('/keys/:keyId/records/:recordId', async c => {
    const owned = await ownedKey(c);
    if (owned.id === null) return c.json({ error: owned.error }, 404);
    const archive = await getDumpArchiveStore().get(owned.id, c.req.param('recordId'));
    if (archive === null) return c.json({ error: 'Record not found' }, 404);
    return c.body(archive, 200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'private, no-store',
    });
  });
