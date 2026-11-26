import type { DumpBroker } from '../../src/dump/broker.ts';
import type { DumpStore } from '../../src/dump/store-contract.ts';
import type { DumpMetadata } from '../../src/dump/types.ts';

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

export const fakeArchive = new TextEncoder().encode([
  '{"type":"object","fromObjectId":1,"nodes":[{}]}',
  '{"type":"stage.entered","stageId":1,"name":"parse","facts":{"$":1}}',
  '{"type":"stage.leaved","stageId":1,"facts":{"$":1}}',
  '',
].join('\n'));

type DumpStubFailMethod =
  | 'list'
  | 'publish'
  | 'closeChannel';

export interface DumpStubHandle {
  store: DumpStore;
  broker: DumpBroker;
  published: ReadonlyArray<{ keyId: string; meta: DumpMetadata }>;
  closedChannels: ReadonlyArray<{ keyId: string; reason: string }>;
  seed: (keyId: string, meta: DumpMetadata) => void;
  failOn: (method: DumpStubFailMethod, err: Error) => void;
}

export const installDumpStubs = (
  initStore: (store: DumpStore) => void,
  initBroker: (broker: DumpBroker) => void,
): DumpStubHandle => {
  const records = new Map<string, DumpMetadata[]>();
  const archives = new Map<string, Map<string, Uint8Array>>();
  const subscribers = new Map<string, Array<(meta: DumpMetadata | null) => void>>();
  const published: Array<{ keyId: string; meta: DumpMetadata }> = [];
  const closedChannels: Array<{ keyId: string; reason: string }> = [];
  const throws: Partial<Record<DumpStubFailMethod, Error>> = {};

  const store: DumpStore = {
    async putArchive(keyId, meta, bytes) {
      const byId = archives.get(keyId) ?? new Map<string, Uint8Array>();
      byId.set(meta.id, bytes);
      archives.set(keyId, byId);
      const list = records.get(keyId) ?? [];
      list.unshift(meta);
      records.set(keyId, list);
    },
    async getArchive(keyId, id) {
      const bytes = archives.get(keyId)?.get(id);
      return bytes === undefined ? null : new Response(bytes as Uint8Array<ArrayBuffer>).body;
    },
    async list(keyId, opts) {
      if (throws.list) throw throws.list;
      const list = records.get(keyId) ?? [];
      let start = 0;
      if (opts.before) {
        const idx = list.findIndex(meta => meta.id === opts.before);
        start = idx >= 0 ? idx + 1 : list.length;
      }
      return list.slice(start, start + opts.limit);
    },
    async deleteExpiredBatch() { return 0; },
    async findOldestCreatedAt() { return null; },
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
    published,
    closedChannels,
    seed: (keyId, record) => {
      const list = records.get(keyId) ?? [];
      list.unshift(record);
      records.set(keyId, list);
    },
    failOn: (method, err) => { throws[method] = err; },
  };
};
