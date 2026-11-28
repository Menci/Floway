import type { Context } from 'hono';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';

import { ownedKeyForUser } from './shared/owned-key.ts';
import { getDumpBroker, getDumpStore } from '../dump/registry.ts';
import type { DumpMetadata } from '../dump/types.ts';
import { dumpRecordToWire } from '../dump/wire.ts';
import { type AuthedContext, userFromContext } from '../middleware/auth.ts';
import { zValidator } from '../middleware/zod-validator.ts';
import { getRepo } from '../repo/index.ts';

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

// The keys whose records the signed-in operator's merged log may read: every
// non-deleted key of their own account that still has retention. Administrators
// are scoped like everyone else — reading another account's request bodies is
// not what the admin role grants.
const dumpKeyIdsFor = async (c: Context): Promise<string[]> => {
  const keys = await getRepo().apiKeys.listByUserId(userFromContext(c as AuthedContext).id);
  return keys.filter(key => key.dumpRetentionSeconds !== null).map(key => key.id);
};

const isFailure = (meta: DumpMetadata): boolean => meta.error !== null || (meta.status ?? 0) >= 400;

// The live stream applies the list's filters so an appended frame cannot widen
// what the SQL page returned. The search fields match the store's
// SEARCH_EXPRESSION one for one: key name is covered, the key's display suffix
// is not.
const matchesFilters = (meta: DumpMetadata, q: string | undefined, failures: boolean): boolean => {
  if (failures && !isFailure(meta)) return false;
  if (!q) return true;
  return [
    meta.id, meta.path, meta.model, meta.upstream?.name, meta.key.name,
    meta.status, meta.error?.kind === 'failed' ? meta.error.reason : meta.error?.kind,
  ].join(' ').toLowerCase().includes(q.toLowerCase());
};

// Pulls frames from every key's channel as they arrive. One channel closing
// (its key lost retention) leaves the others running; the first channel error
// aborts the whole merge, matching the single-key stream's failure shape.
const mergeSubscriptions = async function* (subscriptions: ReadonlyArray<AsyncIterable<DumpMetadata>>): AsyncGenerator<DumpMetadata> {
  const iterators = subscriptions.map(subscription => subscription[Symbol.asyncIterator]());
  const next = new Map<number, Promise<{ index: number; result: IteratorResult<DumpMetadata> }>>();
  for (const [index, iterator] of iterators.entries()) {
    next.set(index, iterator.next().then(result => ({ index, result })));
  }
  try {
    while (next.size > 0) {
      const settled = await Promise.race(next.values());
      if (settled.result.done) {
        next.delete(settled.index);
        continue;
      }
      next.set(settled.index, iterators[settled.index]!.next().then(result => ({ index: settled.index, result })));
      yield settled.result.value;
    }
  } finally {
    // A failed peer's next() may still reject after the race is lost; settling
    // every outstanding read here keeps that rejection observed.
    await Promise.allSettled([...next.values()]);
    for (const iterator of iterators) await iterator.return?.();
  }
};

export const dumpRoutes = new Hono()
  .get('/keys/:keyId/records', zValidator('query', listQuery), async c => {
    const owned = await ownedKey(c);
    if (owned.id === null) return c.json({ error: owned.error }, 404);
    const { limit, before, q, failures } = c.req.valid('query');
    const records = await getDumpStore().list(owned.id, {
      limit: limit ?? LIST_LIMIT_DEFAULT,
      q, failures: failures === 'true',
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
  .get('/keys/:keyId/stream', zValidator('query', listQuery), async c => {
    const { q, failures } = c.req.valid('query');
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
      snapshot = await getDumpStore().list(owned.id, { limit: LIST_LIMIT_DEFAULT, q, failures: failures === 'true' });
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
            if (!matchesFilters(meta, q, failures === 'true')) continue;
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
  })
  // The merged all-keys log: one page across every key the operator has
  // retention on. Same response shape as the single-key list.
  .get('/records', zValidator('query', listQuery), async c => {
    const { limit, before, q, failures } = c.req.valid('query');
    const keyIds = await dumpKeyIdsFor(c);
    const records = await getDumpStore().listAll(keyIds, {
      limit: limit ?? LIST_LIMIT_DEFAULT,
      q, failures: failures === 'true',
      ...(before !== undefined ? { before } : {}),
    });
    return c.json({ records });
  })
  .get('/records/:recordId', async c => {
    const keyIds = await dumpKeyIdsFor(c);
    const record = await getDumpStore().getAny(keyIds, c.req.param('recordId')!);
    if (!record) return c.json({ error: 'Record not found' }, 404);
    return c.json(dumpRecordToWire(record));
  })
  .get('/stream', zValidator('query', listQuery), async c => {
    // Same session-in-query accommodation as the per-key stream; the auth
    // middleware pins this path too.
    const { q, failures } = c.req.valid('query');
    const keyIds = await dumpKeyIdsFor(c);

    // Every channel is subscribed before the snapshot for the same reason as
    // the per-key stream: a record published during the read must arrive as an
    // appended frame rather than be missed by both sides.
    const controller = new AbortController();
    const subscriptions = keyIds.map(keyId => getDumpBroker().subscribe(keyId, controller.signal));
    let snapshot;
    try {
      snapshot = await getDumpStore().listAll(keyIds, { limit: LIST_LIMIT_DEFAULT, q, failures: failures === 'true' });
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
          for await (const meta of mergeSubscriptions(subscriptions)) {
            if (!matchesFilters(meta, q, failures === 'true')) continue;
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
