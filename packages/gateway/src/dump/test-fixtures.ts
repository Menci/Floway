import type { DumpBroker } from './broker.ts';
import type { DumpStore } from './store-contract.ts';
import type { DumpMetadata, StoredDumpRecord } from './types.ts';

export const fakeMeta = (overrides: Partial<DumpMetadata> = {}): DumpMetadata => ({
  id: 'test-id',
  startedAt: 0,
  completedAt: 1,
  method: 'POST',
  path: '/v1/x',
  status: 200,
  upstream: null,
  model: null,
  inputTokens: null,
  outputTokens: null,
  requestBytes: 0,
  responseBytes: 0,
  durationMs: 1,
  error: null,
  ...overrides,
});

export const fakeRecord = (overrides: Partial<DumpMetadata> = {}): StoredDumpRecord => ({
  meta: fakeMeta(overrides),
  request: { method: 'POST', path: '/v1/x', headers: [], body: new Uint8Array() },
  response: { status: 200, headers: [], body: { type: 'none' } },
});

type DumpStubFailMethod =
  | 'put'
  | 'list'
  | 'get'
  | 'purgeAll'
  | 'purgeExpired'
  | 'publish'
  | 'closeChannel';

export interface DumpStubHandle {
  store: DumpStore;
  broker: DumpBroker;
  stored: ReadonlyArray<{ keyId: string; record: StoredDumpRecord }>;
  published: ReadonlyArray<{ keyId: string; meta: DumpMetadata }>;
  purgedAll: ReadonlyArray<string>;
  purgedExpired: ReadonlyArray<{ keyId: string; retentionSeconds: number }>;
  closedChannels: ReadonlyArray<{ keyId: string; reason: string }>;
  seed: (keyId: string, record: StoredDumpRecord) => void;
  failOn: (method: DumpStubFailMethod, err: Error) => void;
}

export const installDumpStubs = (
  initStore: (store: DumpStore) => void,
  initBroker: (broker: DumpBroker) => void,
): DumpStubHandle => {
  const records = new Map<string, StoredDumpRecord[]>();
  const subscribers = new Map<string, Array<(meta: DumpMetadata | null) => void>>();
  const stored: Array<{ keyId: string; record: StoredDumpRecord }> = [];
  const published: Array<{ keyId: string; meta: DumpMetadata }> = [];
  const purgedAll: string[] = [];
  const purgedExpired: Array<{ keyId: string; retentionSeconds: number }> = [];
  const closedChannels: Array<{ keyId: string; reason: string }> = [];
  const throws: Partial<Record<DumpStubFailMethod, Error>> = {};

  const store: DumpStore = {
    async prepareRequestBody(body) {
      return { encoding: 'identity', bytes: body, decodedByteLength: body.byteLength };
    },
    async put(keyId, record) {
      if (throws.put) throw throws.put;
      if (record.request.body.encoding !== 'identity') throw new Error('dump test stub expected identity request body');
      const storedRecord: StoredDumpRecord = {
        ...record,
        request: { ...record.request, body: record.request.body.bytes },
      };
      stored.push({ keyId, record: storedRecord });
      const list = records.get(keyId) ?? [];
      list.unshift(storedRecord);
      records.set(keyId, list);
    },
    async list(keyId, opts) {
      if (throws.list) throw throws.list;
      const list = records.get(keyId) ?? [];
      let start = 0;
      if (opts.before) {
        const idx = list.findIndex(r => r.meta.id === opts.before);
        start = idx >= 0 ? idx + 1 : list.length;
      }
      return list.slice(start, start + opts.limit).map(r => r.meta);
    },
    async get(keyId, id) {
      if (throws.get) throw throws.get;
      return (records.get(keyId) ?? []).find(r => r.meta.id === id) ?? null;
    },
    async purgeAll(keyId) {
      if (throws.purgeAll) throw throws.purgeAll;
      purgedAll.push(keyId);
      records.delete(keyId);
    },
    async purgeExpired(keyId, retentionSeconds) {
      // Record before throwing so tests asserting per-key sweep isolation can
      // observe that key B was visited even when key A's purge threw.
      purgedExpired.push({ keyId, retentionSeconds });
      if (throws.purgeExpired) throw throws.purgeExpired;
    },
  };

  const broker: DumpBroker = {
    async publish(keyId, meta) {
      if (throws.publish) throw throws.publish;
      published.push({ keyId, meta });
      for (const fn of subscribers.get(keyId) ?? []) fn(meta);
    },
    async closeChannel(keyId, reason) {
      if (throws.closeChannel) throw throws.closeChannel;
      closedChannels.push({ keyId, reason });
      for (const fn of subscribers.get(keyId) ?? []) fn(null);
    },
    subscribe(keyId, signal) {
      // Eager listener registration mirrors production: a publish between
      // subscribe() and the iterator's first read still lands in the queue.
      const queue: DumpMetadata[] = [];
      let resolveNext: ((v: IteratorResult<DumpMetadata>) => void) | null = null;
      let closed = false;
      const onMeta = (meta: DumpMetadata | null): void => {
        if (closed) return;
        if (meta === null) {
          closed = true;
          if (resolveNext) { resolveNext({ value: undefined as never, done: true }); resolveNext = null; }
          return;
        }
        if (resolveNext) { resolveNext({ value: meta, done: false }); resolveNext = null; } else queue.push(meta);
      };
      const list = subscribers.get(keyId) ?? [];
      list.push(onMeta);
      subscribers.set(keyId, list);
      signal.addEventListener('abort', () => onMeta(null), { once: true });
      const detach = (): void => {
        const next = (subscribers.get(keyId) ?? []).filter(fn => fn !== onMeta);
        if (next.length === 0) subscribers.delete(keyId);
        else subscribers.set(keyId, next);
      };
      return {
        [Symbol.asyncIterator]: (): AsyncIterator<DumpMetadata> => ({
          async next() {
            if (queue.length > 0) return { value: queue.shift()!, done: false };
            if (closed) { detach(); return { value: undefined as never, done: true }; }
            const v = await new Promise<IteratorResult<DumpMetadata>>(r => { resolveNext = r; });
            if (v.done) detach();
            return v;
          },
          async return() { closed = true; detach(); return { value: undefined as never, done: true }; },
        }),
      };
    },
  };

  initStore(store);
  initBroker(broker);

  return {
    store,
    broker,
    stored,
    published,
    purgedAll,
    purgedExpired,
    closedChannels,
    seed: (keyId, record) => {
      const list = records.get(keyId) ?? [];
      list.unshift(record);
      records.set(keyId, list);
    },
    failOn: (method, err) => { throws[method] = err; },
  };
};
