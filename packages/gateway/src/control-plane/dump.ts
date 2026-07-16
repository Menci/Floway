import type { Context } from 'hono';
import { Hono } from 'hono';
import { z } from 'zod';

import { streamSSE } from '../streaming/sse.ts';
import { ownedKeyOr404 } from './shared/owned-key.ts';
import { getDumpBroker, getDumpStore } from '../dump/registry.ts';
import { dumpRecordToWire } from '../dump/wire.ts';
import { zValidator } from '../middleware/zod-validator.ts';

const LIST_LIMIT_DEFAULT = 100;
const LIST_LIMIT_MAX = 200;

const listQuery = z.object({
  limit: z.coerce.number().int().positive().max(LIST_LIMIT_MAX).optional(),
  before: z.string().min(1).optional(),
});

const ownedKey = async (c: Context): Promise<string | Response> => {
  const keyId = c.req.param('keyId')!;
  const owned = await ownedKeyOr404(c, keyId);
  if (owned instanceof Response) return owned;
  if (owned.dumpRetentionSeconds === null) {
    return c.json({ error: 'Dump capture is not enabled for this key.' }, 404);
  }
  return owned.id;
};

export const dumpRoutes = new Hono()
  .get('/keys/:keyId/records', zValidator('query', listQuery), async c => {
    const owned = await ownedKey(c);
    if (owned instanceof Response) return owned;
    const { limit, before } = c.req.valid('query');
    const records = await getDumpStore().list(owned, {
      limit: limit ?? LIST_LIMIT_DEFAULT,
      ...(before !== undefined ? { before } : {}),
    });
    return c.json({ records });
  })
  .get('/keys/:keyId/records/:recordId', async c => {
    const owned = await ownedKey(c);
    if (owned instanceof Response) return owned;
    const record = await getDumpStore().get(owned, c.req.param('recordId')!);
    if (!record) return c.json({ error: 'Record not found' }, 404);
    return c.json(dumpRecordToWire(record));
  })
  .get('/keys/:keyId/stream', async c => {
    // Browsers cannot set custom headers on EventSource, so this SSE route
    // accepts the session token via `?session=` (path-pinned in
    // authMiddleware).
    const owned = await ownedKey(c);
    if (owned instanceof Response) return owned;

    // Subscribe first, then read the snapshot, so the live broker covers
    // anything new while the snapshot supplies history.
    const controller = new AbortController();
    const subscription = getDumpBroker().subscribe(owned, controller.signal);
    let snapshot;
    try {
      snapshot = await getDumpStore().list(owned, { limit: LIST_LIMIT_DEFAULT });
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
