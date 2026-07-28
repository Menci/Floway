import type { Context } from 'hono';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';

import { ownedKeyForUser } from './shared/owned-key.ts';
import { getDumpBroker, getDumpStore } from '../dump/registry.ts';
import { dumpRecordToWire } from '../dump/wire.ts';
import { zValidator } from '../middleware/zod-validator.ts';

const LIST_LIMIT_DEFAULT = 100;
const LIST_LIMIT_MAX = 200;

const listQuery = z.object({
  limit: z.coerce.number().int().positive().max(LIST_LIMIT_MAX).optional(),
  before: z.string().min(1).optional(),
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
    const { limit, before } = c.req.valid('query');
    const records = await getDumpStore().list(owned.id, {
      limit: limit ?? LIST_LIMIT_DEFAULT,
      ...(before !== undefined ? { before } : {}),
    });
    return c.json({ records });
  })
  .get('/keys/:keyId/records/:recordId', async c => {
    const owned = await ownedKey(c);
    if (owned.id === null) return c.json({ error: owned.error }, 404);
    const record = await getDumpStore().get(owned.id, c.req.param('recordId')!);
    if (!record) return c.json({ error: 'Record not found' }, 404);
    return c.json(dumpRecordToWire(record));
  })
  .get('/keys/:keyId/stream', async c => {
    // Browsers cannot set custom headers on EventSource, so this SSE route
    // accepts the session token via `?session=` (path-pinned in
    // authMiddleware).
    const owned = await ownedKey(c);
    if (owned.id === null) return c.json({ error: owned.error }, 404);

    // Subscribe first, then read the snapshot, so the live broker covers
    // anything new while the snapshot supplies history.
    const controller = new AbortController();
    const subscription = getDumpBroker().subscribe(owned.id, controller.signal);
    let snapshot;
    try {
      snapshot = await getDumpStore().list(owned.id, { limit: LIST_LIMIT_DEFAULT });
    } catch (err) {
      controller.abort();
      throw err;
    }

    return streamSSE(c, async stream => {
      const onAbort = () => controller.abort();
      c.req.raw.signal.addEventListener('abort', onAbort, { once: true });
      try {
        await stream.writeSSE({ event: 'snapshot', data: JSON.stringify({ records: snapshot }) });
        try {
          for await (const meta of subscription) {
            await stream.writeSSE({ event: 'appended', data: JSON.stringify(meta) });
          }
        } catch (err) {
          await stream.writeSSE({
            event: 'error',
            data: JSON.stringify({ message: err instanceof Error ? err.message : String(err) }),
          });
        }
      } finally {
        c.req.raw.signal.removeEventListener('abort', onAbort);
        controller.abort();
      }
    });
  });
