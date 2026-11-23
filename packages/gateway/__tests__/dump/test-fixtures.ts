import type { DumpBroker } from '../../src/dump/broker.ts';
import type { DumpStore } from '../../src/dump/store-contract.ts';
import type { DumpBrokerMessage, DumpMetadata } from '../../src/dump/types.ts';
import type { LogStream, LogStreamStore } from '@floway-dev/platform';

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

type DumpStubFailMethod =
  | 'stageAndPutArtifact'
  | 'commitRecord'
  | 'list'
  | 'getMeta'
  | 'getArtifactStream'
  | 'publish'
  | 'closeChannel';

export interface DumpStubHandle {
  store: DumpStore;
  broker: DumpBroker;
  stored: ReadonlyArray<{ keyId: string; meta: DumpMetadata; artifactKey: string; artifact: Uint8Array }>;
  published: ReadonlyArray<{ keyId: string; frame: DumpBrokerMessage }>;
  closedChannels: ReadonlyArray<{ keyId: string; reason: string }>;
  seed: (keyId: string, meta: DumpMetadata) => void;
  failOn: (method: DumpStubFailMethod, error: Error) => void;
}

const streamOf = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });

const readAll = async (stream: ReadableStream<Uint8Array>): Promise<Uint8Array> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value.slice());
    total += value.byteLength;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

export const installDumpStubs = (
  initStore: (store: DumpStore) => void,
  initBroker: (broker: DumpBroker) => void,
): DumpStubHandle => {
  const records = new Map<string, DumpMetadata[]>();
  const artifacts = new Map<string, Uint8Array>();
  const subscribers = new Map<string, Array<(frame: DumpBrokerMessage | null) => void>>();
  const stored: Array<{ keyId: string; meta: DumpMetadata; artifactKey: string; artifact: Uint8Array }> = [];
  const published: Array<{ keyId: string; frame: DumpBrokerMessage }> = [];
  const closedChannels: Array<{ keyId: string; reason: string }> = [];
  const throws: Partial<Record<DumpStubFailMethod, Error>> = {};

  const store: DumpStore = {
    createArtifactKey(keyId, startedAt, recordId) {
      return `dumps/v2/${keyId}/${startedAt}/${recordId}-${crypto.randomUUID()}.ndjson.gz`;
    },
    async stageAndPutArtifact(_keyId, _recordId, artifactKey, stream) {
      if (throws.stageAndPutArtifact) throw throws.stageAndPutArtifact;
      artifacts.set(artifactKey, await readAll(stream));
    },
    async commitRecord(keyId, record) {
      if (throws.commitRecord) throw throws.commitRecord;
      const list = records.get(keyId) ?? [];
      list.unshift(record.meta);
      records.set(keyId, list);
      stored.push({
        keyId,
        meta: record.meta,
        artifactKey: record.artifactKey,
        artifact: artifacts.get(record.artifactKey)?.slice() ?? new Uint8Array(),
      });
    },
    async list(keyId, opts) {
      if (throws.list) throw throws.list;
      const list = records.get(keyId) ?? [];
      let start = 0;
      if (opts.before !== undefined) {
        const index = list.findIndex(meta => meta.id === opts.before);
        start = index >= 0 ? index + 1 : list.length;
      }
      return list
        .filter(meta => !opts.failures || meta.error !== null || (meta.status ?? 0) >= 400)
        .filter(meta => opts.q === undefined || JSON.stringify(meta).toLowerCase().includes(opts.q.toLowerCase()))
        .slice(start, start + opts.limit);
    },
    async getMeta(keyId, id) {
      if (throws.getMeta) throw throws.getMeta;
      return (records.get(keyId) ?? []).find(meta => meta.id === id) ?? null;
    },
    async getArtifactStream(keyId, id) {
      if (throws.getArtifactStream) throw throws.getArtifactStream;
      const meta = (records.get(keyId) ?? []).find(record => record.id === id);
      if (meta === undefined) return null;
      const entry = stored.find(item => item.keyId === keyId && item.meta.id === id);
      return entry === undefined ? null : streamOf(entry.artifact);
    },
    async deleteExpiredBatch() { return 0; },
    async findOldestCreatedAt() { return null; },
  };

  const broker: DumpBroker = {
    async publish(keyId, frame) {
      if (throws.publish) throw throws.publish;
      published.push({ keyId, frame });
      for (const listener of subscribers.get(keyId) ?? []) listener(frame);
    },
    async closeChannel(keyId, reason) {
      if (throws.closeChannel) throw throws.closeChannel;
      closedChannels.push({ keyId, reason });
      for (const listener of subscribers.get(keyId) ?? []) listener(null);
    },
    subscribe(keyId, signal) {
      const queue: DumpBrokerMessage[] = [];
      let resolveNext: ((value: IteratorResult<DumpBrokerMessage>) => void) | null = null;
      let closed = false;
      const onFrame = (frame: DumpBrokerMessage | null): void => {
        if (closed) return;
        if (frame === null) {
          closed = true;
          resolveNext?.({ value: undefined, done: true });
          resolveNext = null;
          return;
        }
        if (resolveNext !== null) {
          resolveNext({ value: frame, done: false });
          resolveNext = null;
        } else queue.push(frame);
      };
      const listeners = subscribers.get(keyId) ?? [];
      listeners.push(onFrame);
      subscribers.set(keyId, listeners);
      signal.addEventListener('abort', () => onFrame(null), { once: true });
      const detach = (): void => {
        const remaining = (subscribers.get(keyId) ?? []).filter(listener => listener !== onFrame);
        if (remaining.length === 0) subscribers.delete(keyId);
        else subscribers.set(keyId, remaining);
      };
      return {
        [Symbol.asyncIterator]: (): AsyncIterator<DumpBrokerMessage> => ({
          async next() {
            if (queue.length > 0) return { value: queue.shift()!, done: false };
            if (closed) {
              detach();
              return { value: undefined, done: true };
            }
            const value = await new Promise<IteratorResult<DumpBrokerMessage>>(resolve => { resolveNext = resolve; });
            if (value.done) detach();
            return value;
          },
          async return() {
            closed = true;
            detach();
            return { value: undefined, done: true };
          },
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
    closedChannels,
    seed: (keyId, meta) => {
      const list = records.get(keyId) ?? [];
      list.unshift(meta);
      records.set(keyId, list);
    },
    failOn: (method, error) => { throws[method] = error; },
  };
};

class MemoryLogStream implements LogStream {
  private bytes = new Uint8Array(0);
  private ended = false;
  private readonly waiters = new Set<() => void>();

  async append(atOffset: number, chunk: Uint8Array): Promise<void> {
    const fresh = chunk.subarray(this.bytes.byteLength - atOffset);
    if (fresh.byteLength > 0) {
      const next = new Uint8Array(this.bytes.byteLength + fresh.byteLength);
      next.set(this.bytes);
      next.set(fresh, this.bytes.byteLength);
      this.bytes = next;
    }
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }

  async end(): Promise<void> {
    this.ended = true;
    for (const wake of this.waiters) wake();
    this.wakeupsClear();
  }

  private wakeupsClear(): void {
    this.waiters.clear();
  }

  read(fromOffset: number, signal: AbortSignal): AsyncIterable<Uint8Array> {
    const stream = this;
    return {
      async *[Symbol.asyncIterator]() {
        let cursor = fromOffset;
        for (;;) {
          signal.throwIfAborted();
          if (cursor < stream.bytes.byteLength) {
            const slice = stream.bytes.slice(cursor);
            cursor = stream.bytes.byteLength;
            yield slice;
            continue;
          }
          if (stream.ended) return;
          await new Promise<void>(resolve => {
            const wake = (): void => {
              stream.waiters.delete(wake);
              signal.removeEventListener('abort', wake);
              resolve();
            };
            stream.waiters.add(wake);
            signal.addEventListener('abort', wake, { once: true });
            if (signal.aborted) wake();
          });
        }
      },
    };
  }
}

export class MemoryLogStreamStore implements LogStreamStore {
  private readonly streams = new Map<string, MemoryLogStream>();

  async open(streamId: string): Promise<LogStream> {
    let stream = this.streams.get(streamId);
    if (stream === undefined) {
      stream = new MemoryLogStream();
      this.streams.set(streamId, stream);
    }
    return stream;
  }

  async get(streamId: string): Promise<LogStream | null> {
    return this.streams.get(streamId) ?? null;
  }
}
