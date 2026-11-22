import type { Context } from 'hono';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';

import { ownedKeyForUser } from './shared/owned-key.ts';
import { getDumpBroker, getDumpStore } from '../dump/registry.ts';
import { dumpBrokerFrameSchema } from '../dump/schemas.ts';
import type { DumpBrokerMessage, DumpMetadata, DumpRecordDetail } from '../dump/types.ts';
import { dumpLiveStreamId } from '../dump/types.ts';
import { zValidator } from '../middleware/zod-validator.ts';
import { getLogStreamStore, serveLogStream } from '@floway-dev/platform';

const LIST_LIMIT_DEFAULT = 100;
const LIST_LIMIT_MAX = 200;

const listQuery = z.object({
  limit: z.coerce.number().int().positive().max(LIST_LIMIT_MAX).optional(),
  before: z.string().min(1).optional(),
  q: z.string().trim().max(200).optional(),
  failures: z.enum(['true', 'false']).optional(),
});

const liveQuery = z.object({
  offset: z.coerce.number().int().min(0).default(0),
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

const matchesQuery = (frame: DumpBrokerMessage, q: string | undefined): boolean => {
  if (q === undefined) return true;
  const needle = q.toLowerCase();
  if (frame.event === 'started') {
    return [frame.data.id, frame.data.path, frame.data.model]
      .some(value => value?.toLowerCase().includes(needle));
  }
  const { data: meta } = frame;
  return [meta.id, meta.path, meta.model, meta.upstream?.name, meta.status, meta.error?.kind === 'failed' ? meta.error.reason : meta.error?.kind]
    .some(value => value !== null && value !== undefined && String(value).toLowerCase().includes(needle));
};

const isFailure = (meta: DumpMetadata): boolean => meta.error !== null || (meta.status ?? 0) >= 400;

export const dumpRoutes = new Hono()
  .get('/keys/:keyId/records', zValidator('query', listQuery), async c => {
    const owned = await ownedKey(c);
    if (owned.id === null) return c.json({ error: owned.error }, 404);
    const { limit, before, q, failures } = c.req.valid('query');
    const records = await getDumpStore().list(owned.id, {
      limit: limit ?? LIST_LIMIT_DEFAULT,
      q,
      failures: failures === 'true',
      ...(before === undefined ? {} : { before }),
    });
    return c.json({ records });
  })
  .get('/keys/:keyId/records/:recordId', async c => {
    const owned = await ownedKey(c);
    if (owned.id === null) return c.json({ error: owned.error }, 404);
    const meta = await getDumpStore().getMeta(owned.id, c.req.param('recordId')!);
    if (meta === null) return c.json({ error: 'Record not found' }, 404);
    const detail: DumpRecordDetail = { meta };
    return c.json(detail);
  })
  .get('/keys/:keyId/records/:recordId/artifact', async c => {
    const owned = await ownedKey(c);
    if (owned.id === null) return c.json({ error: owned.error }, 404);
    const stream = await getDumpStore().getArtifactStream(owned.id, c.req.param('recordId')!);
    if (stream === null) return c.json({ error: 'Record not found' }, 404);
    return new Response(stream, {
      status: 200,
      headers: {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'private, no-store',
      },
    });
  })
  .get('/keys/:keyId/records/:recordId/live', zValidator('query', liveQuery), async c => {
    const owned = await ownedKey(c);
    if (owned.id === null) return c.json({ error: owned.error }, 404);
    const recordId = c.req.param('recordId')!;
    const stream = await getLogStreamStore().get(dumpLiveStreamId(owned.id, recordId));
    if (stream === null) return c.json({ error: 'Live stream not found' }, 404);
    return serveLogStream(stream, c.req.valid('query').offset, c.req.raw.signal);
  })
  .get('/keys/:keyId/stream', zValidator('query', listQuery), async c => {
    const { q, failures } = c.req.valid('query');
    const owned = await ownedKey(c);
    if (owned.id === null) return c.json({ error: owned.error }, 404);

    const controller = new AbortController();
    const subscription = getDumpBroker().subscribe(owned.id, controller.signal);
    let records: DumpMetadata[];
    try {
      records = await getDumpStore().list(owned.id, {
        limit: LIST_LIMIT_DEFAULT,
        q,
        failures: failures === 'true',
      });
    } catch (error) {
      controller.abort();
      throw error;
    }

    return streamSSE(c, async stream => {
      const onAbort = () => controller.abort();
      c.req.raw.signal.addEventListener('abort', onAbort, { once: true });
      try {
        await stream.writeSSE({ event: 'snapshot', data: JSON.stringify({ records }) });
        try {
          for await (const frame of subscription) {
            const parsed = dumpBrokerFrameSchema.parse(frame);
            if (parsed.event === 'started' && failures === 'true') continue;
            if (parsed.event === 'appended' && failures === 'true' && !isFailure(parsed.data)) continue;
            if (!matchesQuery(parsed, q)) continue;
            await stream.writeSSE({ event: parsed.event, data: JSON.stringify(parsed.data) });
          }
        } catch (error) {
          await stream.writeSSE({
            event: 'error',
            data: JSON.stringify({ message: error instanceof Error ? error.message : String(error) }),
          });
        }
      } finally {
        c.req.raw.signal.removeEventListener('abort', onAbort);
        controller.abort();
      }
    });
  });
