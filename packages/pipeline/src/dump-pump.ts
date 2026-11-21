import { createDumpEncoder } from './dump-encoder.ts';
import type { DumpEncoderOptions } from './dump-encoder.ts';
import type { EncodedDumpEvent, RawRunEvent, RunTraceSink } from './types.ts';

export interface DumpCompletionSummary {
  readonly runId: string;
  readonly pipelineName: string;
  readonly startedAt: number;
  readonly ok: boolean;
  readonly durationMs: number;
  readonly totalBytes: number;
  readonly truncated: boolean;
  readonly droppedEvents: number;
  readonly summary?: Readonly<Record<string, unknown>>;
}

export interface DumpPumpOptions {
  readonly encoderOptions?: DumpEncoderOptions;
  readonly batchSize?: number;
  readonly maxQueuedEvents?: number;
  readonly maxQueuedBytes?: number;
  readonly maxLiveFailures?: number;
  readonly onLiveChunk?: (offset: number, bytes: Uint8Array) => Promise<void> | void;
  readonly onLiveEnd?: (totalBytes: number) => Promise<void> | void;
  readonly writeArtifact?: (stream: ReadableStream<Uint8Array>) => Promise<void>;
  readonly commitMetadata?: (summary: DumpCompletionSummary) => Promise<void>;
  readonly onReady?: (summary: DumpCompletionSummary) => Promise<void> | void;
  readonly waitUntil?: (promise: Promise<unknown>) => void;
}

export interface DumpPump extends RunTraceSink {
  readonly completion: Promise<DumpCompletionSummary>;
  readonly push: (event: RawRunEvent) => void;
  readonly registerSecretPlaintext: (plaintext: string) => void;
  readonly acquireProducerLease: () => () => void;
}

type RunEvent = Extract<RawRunEvent, { readonly k: 'run' }>;
type DoneEvent = Extract<RawRunEvent, { readonly k: 'done' }>;
type QueuedEvent = { readonly event: RawRunEvent; readonly bytes: number };

const yieldToEventLoop = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

const isCriticalEvent = (event: RawRunEvent): boolean => event.k !== 'frame' && event.k !== 'log';

const ensurePositiveInteger = (value: number, name: string): number => {
  if (!Number.isInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
  return value;
};

const estimateQueuedBytes = (
  value: unknown,
  textEncoder: TextEncoder,
  seen = new WeakSet<object>(),
): number => {
  if (value === null) return 4;
  if (value instanceof Uint8Array) return value.byteLength;
  if (typeof value === 'string') return textEncoder.encode(value).byteLength + 2;
  if (typeof value === 'bigint') return value.toString().length + 8;
  if (typeof value === 'boolean') return 5;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value).length : 8;
  if (typeof value !== 'object') return 2;
  if (seen.has(value)) return 4;
  seen.add(value);
  if (Array.isArray(value)) {
    return 2 + value.reduce<number>((size, child) => size + 1 + estimateQueuedBytes(child, textEncoder, seen), 0);
  }
  let size = 2;
  if (value instanceof Error) {
    size += estimateQueuedBytes(value.name, textEncoder, seen);
    size += estimateQueuedBytes(value.message, textEncoder, seen);
    size += estimateQueuedBytes(value.stack, textEncoder, seen);
    if ('cause' in value) size += estimateQueuedBytes(value.cause, textEncoder, seen);
    if (value instanceof AggregateError) size += estimateQueuedBytes(value.errors, textEncoder, seen);
  }
  for (const [key, child] of Object.entries(value)) {
    size += textEncoder.encode(key).byteLength + 3 + estimateQueuedBytes(child, textEncoder, seen);
  }
  return size;
};

export const createDumpPump = (options: DumpPumpOptions = {}): DumpPump => {
  const batchSize = ensurePositiveInteger(options.batchSize ?? 128, 'batchSize');
  const maxQueuedEvents = ensurePositiveInteger(options.maxQueuedEvents ?? 16_384, 'maxQueuedEvents');
  const maxQueuedBytes = ensurePositiveInteger(options.maxQueuedBytes ?? 32 * 1024 * 1024, 'maxQueuedBytes');
  const maxLiveFailures = ensurePositiveInteger(options.maxLiveFailures ?? 3, 'maxLiveFailures');
  const encoder = createDumpEncoder(options.encoderOptions);
  const textEncoder = new TextEncoder();

  let queue: QueuedEvent[] = [];
  let queueHead = 0;
  let scheduled = false;
  let draining = false;
  let finalizing = false;
  let settled = false;
  let activeProducerLeases = 0;
  let runEvent: RunEvent | undefined;
  let doneEvent: DoneEvent | undefined;
  let totalBytes = 0;
  let droppedEvents = 0;
  let unemittedDroppedEvents = 0;
  let lastDroppedEvent: RawRunEvent | undefined;
  let liveFailureCount = 0;
  let liveCircuitOpen = false;
  let queuedBytes = 0;

  let resolvePromise!: (summary: DumpCompletionSummary) => void;
  let rejectPromise!: (error: unknown) => void;
  const completion = new Promise<DumpCompletionSummary>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  const resolveCompletion = (summary: DumpCompletionSummary): void => {
    if (settled) return;
    settled = true;
    resolvePromise(summary);
  };

  const artifactTransform = options.writeArtifact === undefined
    ? undefined
    : new TransformStream<Uint8Array, Uint8Array>(
        undefined,
        { highWaterMark: 65_536, size: chunk => chunk.byteLength },
        { highWaterMark: 65_536, size: chunk => chunk.byteLength },
      );
  const artifactWriter = artifactTransform?.writable.getWriter();

  let artifactWrite: Promise<void> = Promise.resolve();
  if (options.writeArtifact !== undefined && artifactTransform !== undefined) {
    try {
      artifactWrite = options.writeArtifact(artifactTransform.readable);
    } catch (error) {
      artifactWrite = Promise.reject(error);
    }
  }
  void artifactWrite.catch(error => finishWithError(error));

  const pendingCount = (): number => queue.length - queueHead;

  const compactQueue = (): void => {
    if (queueHead === 0) return;
    if (queueHead === queue.length) {
      queue = [];
      queueHead = 0;
      return;
    }
    if (queueHead >= 1_024 && queueHead * 2 >= queue.length) {
      queue = queue.slice(queueHead);
      queueHead = 0;
    }
  };

  const finishWithError = (error: unknown): void => {
    if (settled) return;
    settled = true;
    finalizing = true;
    void artifactWriter?.abort(error).catch(() => undefined);
    rejectPromise(error);
  };

  const writeChunk = async (bytes: Uint8Array): Promise<void> => {
    if (settled) return;
    if (finalizing) throw new Error('Cannot write a dump chunk while finalization is in progress');
    if (artifactWriter !== undefined) {
      await artifactWriter.ready;
      await artifactWriter.write(bytes);
    }
    const offset = totalBytes;
    totalBytes += bytes.byteLength;
    if (liveCircuitOpen || options.onLiveChunk === undefined) return;
    try {
      await options.onLiveChunk(offset, bytes);
    } catch {
      liveFailureCount++;
      if (liveFailureCount >= maxLiveFailures) liveCircuitOpen = true;
    }
  };

  const writeEncoded = async (event: EncodedDumpEvent): Promise<void> => {
    await writeChunk(textEncoder.encode(`${JSON.stringify(event)}\n`));
  };

  const writeTruncationMarker = async (): Promise<void> => {
    if (unemittedDroppedEvents === 0) return;
    const event = lastDroppedEvent;
    if (event === undefined) throw new Error('Dropped event accounting was lost');
    await writeEncoded({
      k: 'truncated',
      seq: event.seq,
      tMs: event.tMs,
      reason: 'queue-overflow',
      droppedEvents,
    });
    unemittedDroppedEvents = 0;
  };

  const makeSummary = (): DumpCompletionSummary => {
    if (runEvent === undefined) throw new Error('Cannot complete a dump before its run event');
    if (doneEvent === undefined) throw new Error('Cannot complete a dump before its done event');
    return {
      runId: runEvent.runId,
      pipelineName: runEvent.pipelineName,
      startedAt: runEvent.startedAt,
      ok: doneEvent.ok,
      durationMs: doneEvent.tMs - runEvent.tMs,
      totalBytes,
      truncated: droppedEvents > 0,
      droppedEvents,
      ...(doneEvent.summary === undefined ? {} : { summary: doneEvent.summary }),
    };
  };

  const finalize = async (): Promise<void> => {
    if (finalizing || settled) return;
    finalizing = true;
    const summary = makeSummary();
    if (artifactWriter !== undefined) {
      await artifactWriter.ready;
      await artifactWriter.close();
    }
    await artifactWrite;
    await options.commitMetadata?.(summary);
    if (!liveCircuitOpen) await options.onLiveEnd?.(totalBytes);
    await options.onReady?.(summary);
    resolveCompletion(summary);
  };

  const drain = async (): Promise<void> => {
    if (draining || finalizing || settled) return;
    scheduled = false;
    draining = true;
    try {
      await yieldToEventLoop();
      while (!finalizing && !settled) {
        const count = Math.min(batchSize, pendingCount());
        if (count === 0) break;
        const batch = queue.slice(queueHead, queueHead + count);
        queueHead += count;
        for (const entry of batch) queuedBytes -= entry.bytes;
        compactQueue();
        for (const event of encoder.encodeBatch(batch.map(entry => entry.event))) await writeEncoded(event);
        await yieldToEventLoop();
      }
      if (pendingCount() === 0) await writeTruncationMarker();
      if (doneEvent !== undefined && activeProducerLeases === 0 && pendingCount() === 0) {
        await finalize();
        return;
      }
      draining = false;
      if (pendingCount() > 0) scheduleDrain();
    } catch (error) {
      draining = false;
      finishWithError(error);
      return;
    }
  };

  function scheduleDrain(): void {
    if (scheduled || draining || finalizing || settled) return;
    scheduled = true;
    void drain();
  }

  const push = (event: RawRunEvent): void => {
    if (finalizing || settled) throw new Error('Cannot push an event after dump completion');
    if (event.k === 'run') {
      if (runEvent !== undefined) throw new Error('A dump run may only start once');
      runEvent = event;
    } else if (event.k === 'done') {
      if (doneEvent !== undefined) throw new Error('A dump run may only finish once');
      doneEvent = event;
    }

    const eventBytes = event.k === 'frame' || event.k === 'log'
      ? estimateQueuedBytes(event, textEncoder)
      : 0;
    if (!isCriticalEvent(event) && (pendingCount() >= maxQueuedEvents || queuedBytes + eventBytes > maxQueuedBytes)) {
      droppedEvents++;
      unemittedDroppedEvents++;
      lastDroppedEvent = event;
      scheduleDrain();
      return;
    }
    queuedBytes += eventBytes;
    queue.push({ event, bytes: eventBytes });
    scheduleDrain();
  };

  const acquireProducerLease = (): (() => void) => {
    if (finalizing || settled) throw new Error('Cannot acquire a producer lease after dump completion');
    activeProducerLeases++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      activeProducerLeases--;
      scheduleDrain();
    };
  };

  options.waitUntil?.(completion.then(() => undefined));

  return {
    completion,
    push,
    registerSecretPlaintext: encoder.registerSecretPlaintext,
    acquireProducerLease,
  };
};
