import { createParser } from 'eventsource-parser';

import { type SseFrame, sseFrame } from './sse.ts';

const DEFAULT_MAX_EVENT_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_CONSECUTIVE_EMPTY_CHUNKS = 64;
const INPUT_SLICE_BYTES = 64 * 1024;
const READS_PER_TIMER_YIELD = 64;
const ABORTED = Symbol('aborted');

export interface ParseSSEStreamOptions {
  maxConsecutiveEmptyChunks?: number;
  maxEventBytes?: number;
  signal?: AbortSignal;
}

interface Failure {
  readonly error: unknown;
}

interface ReaderCancellation {
  failure?: Failure;
  settled: boolean;
  settlement: Promise<void>;
}

interface RawEventState {
  eventBytes: number;
  lineBytes: number;
  pendingCarriageReturn: boolean;
  pendingLineWasEmpty: boolean;
}

export class SseEventByteLimitError extends Error {
  constructor(readonly maxEventBytes: number) {
    super(`Upstream SSE event exceeded ${maxEventBytes} raw bytes`);
    this.name = 'SseEventByteLimitError';
  }
}

const positiveSafeInteger = (name: string, value: number): number => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer`);
  return value;
};

const beginReaderCancellation = (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reason: unknown,
  current: ReaderCancellation | undefined,
): ReaderCancellation => {
  if (current) return current;
  let cancellation: Promise<void>;
  try {
    cancellation = reader.cancel(reason);
  } catch (error) {
    cancellation = Promise.reject(error);
  }
  const state: ReaderCancellation = { settled: false, settlement: Promise.resolve() };
  state.settlement = cancellation.then(
    () => {
      state.settled = true;
    },
    error => {
      state.failure = { error };
      state.settled = true;
    },
  );
  return state;
};

const observeBoundedCancellation = async (cancellation: ReaderCancellation): Promise<Failure | undefined> => {
  if (cancellation.settled) return cancellation.failure;
  let settlementWindow: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    cancellation.settlement,
    new Promise<void>(resolve => {
      settlementWindow = setTimeout(() => {
        settlementWindow = undefined;
        resolve();
      }, 0);
    }),
  ]);
  if (settlementWindow !== undefined) clearTimeout(settlementWindow);
  return cancellation.failure;
};

const failureWithCleanup = (primary: unknown, cleanupFailures: readonly unknown[]): unknown => {
  if (cleanupFailures.length === 0) return primary;
  if (cleanupFailures.length === 1 && primary instanceof Error) {
    try {
      if (primary.cause === undefined) {
        Object.defineProperty(primary, 'cause', { configurable: true, value: cleanupFailures[0] });
        return primary;
      }
    } catch {
      // The aggregate below preserves both failures when the primary is immutable.
    }
  }
  return new AggregateError(
    [primary, ...cleanupFailures],
    'Upstream SSE stream and cleanup failed',
    { cause: primary },
  );
};

const cleanupFailure = (cleanupFailures: readonly unknown[]): unknown => cleanupFailures.length === 1
  ? cleanupFailures[0]
  : new AggregateError(cleanupFailures, 'Upstream SSE cleanup failed');

const reportLateCancellationFailure = (cancellation: ReaderCancellation, primary: Failure | undefined): void => {
  void cancellation.settlement.then(() => {
    if (!cancellation.failure) return;
    const error = primary === undefined
      ? cancellation.failure.error
      : failureWithCleanup(primary.error, [cancellation.failure.error]);
    console.error('Failed to cancel upstream SSE body:', error);
  });
};

const consumeRawEventBytes = (state: RawEventState, bytes: Uint8Array, maxEventBytes: number): void => {
  const consumeByte = (): void => {
    state.eventBytes++;
    if (state.eventBytes > maxEventBytes) throw new SseEventByteLimitError(maxEventBytes);
  };

  for (const byte of bytes) {
    if (state.pendingCarriageReturn) {
      if (byte === 0x0a) {
        consumeByte();
        if (state.pendingLineWasEmpty) state.eventBytes = 0;
        state.pendingCarriageReturn = false;
        continue;
      }
      if (state.pendingLineWasEmpty) state.eventBytes = 0;
      state.pendingCarriageReturn = false;
    }

    consumeByte();
    if (byte === 0x0d) {
      state.pendingCarriageReturn = true;
      state.pendingLineWasEmpty = state.lineBytes === 0;
      state.lineBytes = 0;
    } else if (byte === 0x0a) {
      const lineWasEmpty = state.lineBytes === 0;
      state.lineBytes = 0;
      if (lineWasEmpty) state.eventBytes = 0;
    } else {
      state.lineBytes++;
    }
  }
};

const yieldToTimers = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

export const parseSSEStream = async function* (
  body: ReadableStream<Uint8Array>,
  options: ParseSSEStreamOptions = {},
): AsyncGenerator<SseFrame> {
  const maxEventBytes = positiveSafeInteger('maxEventBytes', options.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES);
  const maxConsecutiveEmptyChunks = positiveSafeInteger(
    'maxConsecutiveEmptyChunks',
    options.maxConsecutiveEmptyChunks ?? DEFAULT_MAX_CONSECUTIVE_EMPTY_CHUNKS,
  );
  const reader = body.getReader();
  const { signal } = options;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const rawEventState: RawEventState = {
    eventBytes: 0,
    lineBytes: 0,
    pendingCarriageReturn: false,
    pendingLineWasEmpty: false,
  };
  let pendingFrames: SseFrame[] = [];
  let cancellation: ReaderCancellation | undefined;
  let primaryFailure: Failure | undefined;
  let consecutiveEmptyChunks = 0;
  let reads = 0;
  let resolveAbort!: (value: typeof ABORTED) => void;
  const abort = signal === undefined
    ? undefined
    : new Promise<typeof ABORTED>(resolve => { resolveAbort = resolve; });

  const parser = createParser({
    onEvent: event => {
      pendingFrames.push(sseFrame(event.data, event.event));
    },
  });

  const takePendingFrames = (): SseFrame[] => {
    const frames = pendingFrames;
    pendingFrames = [];
    return frames;
  };

  const cancelReader = (reason: unknown): void => {
    cancellation = beginReaderCancellation(reader, reason, cancellation);
  };
  const onAbort = (): void => {
    cancelReader(signal?.reason);
    resolveAbort(ABORTED);
  };

  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });

  try {
    if (signal?.aborted) return;
    for (;;) {
      const read = reader.read();
      const result = abort === undefined ? await read : await Promise.race([read, abort]);
      if (result === ABORTED) return;
      if (result.done) break;

      reads++;
      if (result.value.byteLength === 0) {
        consecutiveEmptyChunks++;
        if (consecutiveEmptyChunks > maxConsecutiveEmptyChunks) {
          throw new Error(`Upstream SSE stream exceeded ${maxConsecutiveEmptyChunks} consecutive empty chunks`);
        }
      } else {
        consecutiveEmptyChunks = 0;
        for (let offset = 0; offset < result.value.byteLength; offset += INPUT_SLICE_BYTES) {
          const slice = result.value.subarray(offset, offset + INPUT_SLICE_BYTES);
          consumeRawEventBytes(rawEventState, slice, maxEventBytes);
          const decoded = decoder.decode(slice, { stream: true });
          if (decoded !== '') parser.feed(decoded);
          for (const frame of takePendingFrames()) {
            if (signal?.aborted) return;
            yield frame;
          }
        }
      }

      if (reads % READS_PER_TIMER_YIELD === 0) {
        const yielded = abort === undefined
          ? await yieldToTimers()
          : await Promise.race([yieldToTimers(), abort]);
        if (yielded === ABORTED) return;
      }
    }

    const finalChunk = decoder.decode();
    if (finalChunk) parser.feed(finalChunk);
    // Preserve the existing contract that a final data line is consumable even
    // when its peer closes without writing the terminating blank line.
    parser.feed('\n\n');
    for (const frame of takePendingFrames()) {
      if (signal?.aborted) return;
      yield frame;
    }
  } catch (error) {
    primaryFailure = { error };
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    cancellation = beginReaderCancellation(reader, primaryFailure?.error, cancellation);
    const cancellationState = cancellation;
    const cleanupFailures: unknown[] = [];
    const cancellationFailure = await observeBoundedCancellation(cancellationState);
    if (cancellationFailure && (primaryFailure === undefined || cancellationFailure.error !== primaryFailure.error)) {
      cleanupFailures.push(cancellationFailure.error);
    }
    if (!cancellationState.settled) reportLateCancellationFailure(cancellationState, primaryFailure);
    try {
      reader.releaseLock();
    } catch (error) {
      cleanupFailures.push(error);
    }

    if (primaryFailure && cleanupFailures.length > 0) {
      throw failureWithCleanup(primaryFailure.error, cleanupFailures);
    }
    if (primaryFailure === undefined && cleanupFailures.length > 0) {
      throw cleanupFailure(cleanupFailures);
    }
  }
};
