import { createDumpEncoder } from './encoder.ts';
import type { DumpEncoderOptions } from './encoder.ts';
import type { EncodedDumpEvent } from './types.ts';
import type { ErrorSnapshot, RunEvent, RunEventSink } from '@floway-dev/pipeline';

export interface DumpCompletionSummary {
  readonly totalBytes: number;
  readonly truncated: boolean;
  readonly droppedEvents: number;
  readonly ok: boolean;
  readonly doneError?: ErrorSnapshot;
}

export interface DumpPumpOptions {
  readonly encoderOptions?: DumpEncoderOptions;
  readonly batchSize?: number;
  readonly maxQueuedEvents?: number;
  readonly maxArtifactBytes?: number;
  readonly maxLiveBufferedBytes?: number;
  readonly onLiveChunk?: (offset: number, bytes: Uint8Array) => Promise<void> | void;
  readonly onLiveEnd?: () => Promise<void> | void;
}

export interface DumpPump {
  readonly sink: RunEventSink;
  readonly artifact: ReadableStream<Uint8Array>;
  readonly completed: Promise<DumpCompletionSummary>;
  readonly liveLagged: boolean;
  readonly registerSecretPlaintext: (value: string) => void;
}

type DoneEvent = Extract<RunEvent, { k: 'done' }>;
type RunHeader = Extract<RunEvent, { k: 'run' }>;
type TruncationEvent = Extract<EncodedDumpEvent, { k: 'truncated' }>;

const nextTurn = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

const positiveInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`);
  return value;
};

const createLiveDelivery = ({ maxLiveBufferedBytes = 4 * 1024 * 1024, onLiveChunk, onLiveEnd }: DumpPumpOptions) => {
  const limit = positiveInteger(maxLiveBufferedBytes, 'maxLiveBufferedBytes');
  let queue: ({ offset: number; bytes: Uint8Array } | undefined)[] = [];
  let head = 0;
  let bufferedBytes = 0;
  let delivering = false;
  let ended = false;
  let notifiedEnd = false;
  let lagged = false;

  const drop = (): void => {
    lagged = true;
    queue = [];
    head = 0;
  };

  const deliver = async (): Promise<void> => {
    if (delivering) return;
    delivering = true;
    try {
      // Start on a separate turn even when the observer's callback does synchronous work.
      await nextTurn();
      while (head < queue.length) {
        const entry = queue[head]!;
        queue[head++] = undefined;
        if (head === queue.length) {
          queue = [];
          head = 0;
        } else if (head >= 256 && head * 2 >= queue.length) {
          queue = queue.slice(head);
          head = 0;
        }
        const length = entry.bytes.byteLength;
        await onLiveChunk?.(entry.offset, entry.bytes);
        bufferedBytes -= length;
      }
    } catch (_observerError: unknown) {
      drop();
    }
    if (ended && !notifiedEnd) {
      notifiedEnd = true;
      try {
        await onLiveEnd?.();
      } catch (_observerError: unknown) {
        drop();
      }
    }
    delivering = false;
  };

  return {
    append(offset: number, bytes: Uint8Array): void {
      if (onLiveChunk === undefined || lagged) return;
      if (bufferedBytes + bytes.byteLength > limit) {
        drop();
        return;
      }
      bufferedBytes += bytes.byteLength;
      queue.push({ offset, bytes: bytes.slice() });
      void deliver();
    },
    end(): void {
      ended = true;
      if (onLiveEnd !== undefined) void deliver();
    },
    get lagged(): boolean { return lagged; },
  };
};

const textEncoder = new TextEncoder();
const ndjson = (events: readonly EncodedDumpEvent[]): Uint8Array =>
  textEncoder.encode(events.map(event => `${JSON.stringify(event)}\n`).join(''));

// Reserve space for both terminal lines with the widest possible JSON numbers.
const footerReserve = ndjson([
  { k: 'truncated', seq: 0, tMs: 0, reason: 'queue-limit' },
  { k: 'done', seq: 0, tMs: 0, ok: false },
]).byteLength + 4 * (25 - 1);

export const createDumpPump = (options: DumpPumpOptions = {}): DumpPump => {
  const batchSize = positiveInteger(options.batchSize ?? 128, 'batchSize');
  const maxQueuedEvents = positiveInteger(options.maxQueuedEvents ?? 4_096, 'maxQueuedEvents');
  const maxBytes = positiveInteger(options.maxArtifactBytes ?? 16 * 1024 * 1024, 'maxArtifactBytes');
  let encoder: ReturnType<typeof createDumpEncoder> | undefined = createDumpEncoder(options.encoderOptions);
  const live = createLiveDelivery(options);
  const { readable: artifact, writable } = new TransformStream<Uint8Array>();
  const writer = writable.getWriter();
  const completion = Promise.withResolvers<DumpCompletionSummary>();

  let queue: (RunEvent | undefined)[] = [];
  let head = 0;
  let writing = false;
  let failed = false;
  let totalBytes = 0;
  let receivedEvents = 0;
  let writtenEvents = 0;
  let pendingHeader: RunHeader | undefined;
  let done: DoneEvent | undefined;
  let truncation: TruncationEvent | undefined;

  const write = async (bytes: Uint8Array): Promise<void> => {
    const length = bytes.byteLength;
    live.append(totalBytes, bytes);
    await writer.write(bytes);
    totalBytes += length;
  };

  const truncate = (event: RunEvent, reason: TruncationEvent['reason']): void => {
    truncation = { k: 'truncated', seq: event.seq, tMs: event.tMs, reason };
    const first = queue[head];
    if (first?.k === 'run') pendingHeader = first;
    encoder = undefined;
    queue = [];
    head = 0;
  };

  const reject = (error: unknown): void => {
    if (failed) return;
    failed = true;
    encoder = undefined;
    pendingHeader = undefined;
    queue = [];
    head = 0;
    live.end();
    completion.reject(error);
  };

  const drain = async (): Promise<void> => {
    writing = true;
    try {
      await nextTurn();
      if (pendingHeader !== undefined) {
        const bytes = ndjson([pendingHeader]);
        if (bytes.byteLength + footerReserve > maxBytes) throw new RangeError('maxArtifactBytes cannot hold the run header and footer');
        pendingHeader = undefined;
        await write(bytes);
        writtenEvents++;
      }
      while (queue.length > head && encoder !== undefined) {
        let remaining = Math.min(batchSize, queue.length - head);
        while (remaining > 0 && encoder !== undefined) {
          const event = queue[head]!;
          const { group, count } = encoder.encodeGroup(queue, head, head + remaining);
          const bytes = ndjson(group);
          if (totalBytes + bytes.byteLength + footerReserve > maxBytes) {
            if (event.k === 'run') throw new RangeError('maxArtifactBytes cannot hold the run header and footer');
            truncate(event, 'size-limit');
            break;
          }
          const end = head + count;
          while (head < end) queue[head++] = undefined;
          remaining -= count;
          if (head === queue.length) {
            queue = [];
            head = 0;
          } else if (head >= 1_024 && head * 2 >= queue.length) {
            queue = queue.slice(head);
            head = 0;
          }
          await write(bytes);
          writtenEvents += count;
        }
        if (queue.length > head) await nextTurn();
      }
      if (!failed && done !== undefined) {
        const { error, ...bareDone } = done;
        let footer = ndjson(encoder === undefined ? [bareDone] : encoder.encodeBatch([done]));
        encoder = undefined;
        if (totalBytes + footer.byteLength > maxBytes) {
          truncate(done, 'size-limit');
          footer = ndjson([bareDone]);
        }
        if (truncation !== undefined) await write(ndjson([truncation]));
        await write(footer);
        await writer.close();
        live.end();
        completion.resolve({
          totalBytes,
          truncated: truncation !== undefined,
          droppedEvents: receivedEvents - writtenEvents,
          ok: done.ok,
          ...(error === undefined ? {} : { doneError: error }),
        });
      }
    } catch (error) {
      reject(error);
      void writer.abort(error).catch(() => undefined);
    } finally {
      writing = false;
    }
  };

  void writer.closed.catch(reject);

  const sink: RunEventSink = event => {
    if (done !== undefined) throw new Error('Cannot record events after done');
    if (failed) return;
    if (event.k === 'done') {
      done = event;
    } else {
      receivedEvents++;
      if (truncation !== undefined) return;
      if (queue.length - head >= maxQueuedEvents) truncate(event, 'queue-limit');
      else queue.push(event);
    }
    if (!writing) void drain();
  };

  return {
    sink,
    artifact,
    completed: completion.promise,
    get liveLagged(): boolean { return live.lagged; },
    registerSecretPlaintext: value => encoder?.registerSecretPlaintext(value),
  };
};
