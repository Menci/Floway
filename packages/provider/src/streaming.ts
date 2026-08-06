import type { ProviderStreamResult } from './provider.ts';
import { isEventStreamMediaType, type ProtocolFrame } from '@floway-dev/protocols/common';

export type ProviderStreamParser<TEvent> = (
  body: ReadableStream<Uint8Array>,
  options?: { signal?: AbortSignal },
) => AsyncIterable<ProtocolFrame<TEvent>>;

const BODY_SNIPPET_CHARS = 1024;
const BODY_SNIPPET_BYTES = BODY_SNIPPET_CHARS * 4;
const BODY_SNIPPET_IDLE_TIMEOUT_MS = 1_000;
const BODY_SNIPPET_TOTAL_TIMEOUT_MS = 5_000;
const BODY_SNIPPET_MAX_EMPTY_CHUNKS = 64;
const BODY_SNIPPET_TIMER_YIELD_INTERVAL = 32;
const CANCELLATION_SETTLEMENT_MICROTASKS = 4;

interface Failure {
  readonly error: unknown;
}

interface ReaderCancellation {
  settled: boolean;
  failure?: Failure;
  settlement: Promise<void>;
}

interface BodySnippet {
  readonly text: string;
  readonly cleanupFailure?: unknown;
}

const timeoutError = (scope: 'idle' | 'total', timeoutMs: number): DOMException =>
  new DOMException(`Upstream stream diagnostic ${scope} timeout after ${timeoutMs}ms`, 'TimeoutError');

const raceWithSignal = <T>(operation: Promise<T>, signal: AbortSignal): Promise<T> => {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
};

const aggregateFailure = (primary: unknown, cleanupFailures: readonly unknown[], message: string): unknown =>
  cleanupFailures.length === 0
    ? primary
    : new AggregateError([primary, ...cleanupFailures], message, { cause: primary });

const aggregateCleanupFailures = (cleanupFailures: readonly unknown[]): unknown =>
  cleanupFailures.length === 1
    ? cleanupFailures[0]
    : new AggregateError(cleanupFailures, 'Upstream stream diagnostic cleanup failed');

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

const observeImmediateCancellation = async (cancellation: ReaderCancellation): Promise<Failure | undefined> => {
  for (let turn = 0; turn < CANCELLATION_SETTLEMENT_MICROTASKS && !cancellation.settled; turn++) {
    await Promise.resolve();
  }
  return cancellation.failure;
};

const reportLateCancellationFailure = (cancellation: ReaderCancellation, primaryFailure: unknown): void => {
  void cancellation.settlement.then(() => {
    if (!cancellation.failure) return;
    const error = primaryFailure === undefined
      ? cancellation.failure.error
      : aggregateFailure(primaryFailure, [cancellation.failure.error], 'Upstream stream diagnostic cleanup failed');
    console.error('Failed to cancel upstream stream diagnostic body:', error);
  });
};

const yieldToTimers = async (): Promise<void> => await new Promise(resolve => setTimeout(resolve, 0));

const readBodySnippet = async (response: Response, callerSignal: AbortSignal | undefined): Promise<BodySnippet> => {
  if (!response.body) return { text: '<empty>' };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const operation = new AbortController();
  let text = '';
  let capturedBytes = 0;
  let emptyChunks = 0;
  let reads = 0;
  let completed = false;
  let snippet: string | undefined;
  let failure: Failure | undefined;
  let cancellation: ReaderCancellation | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const cleanupFailures: unknown[] = [];

  const cancelReader = (reason: unknown): void => {
    cancellation = beginReaderCancellation(reader, reason, cancellation);
  };
  const abortOperation = (reason: unknown): void => {
    if (!operation.signal.aborted) operation.abort(reason);
  };
  const onCallerAbort = () => abortOperation(callerSignal?.reason);
  const onOperationAbort = () => cancelReader(operation.signal.reason);
  const armIdleTimer = (): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => abortOperation(timeoutError('idle', BODY_SNIPPET_IDLE_TIMEOUT_MS)),
      BODY_SNIPPET_IDLE_TIMEOUT_MS,
    );
  };

  operation.signal.addEventListener('abort', onOperationAbort, { once: true });
  if (callerSignal?.aborted) abortOperation(callerSignal.reason);
  else callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
  const totalTimer = setTimeout(
    () => abortOperation(timeoutError('total', BODY_SNIPPET_TOTAL_TIMEOUT_MS)),
    BODY_SNIPPET_TOTAL_TIMEOUT_MS,
  );
  if (!operation.signal.aborted) armIdleTimer();

  try {
    operation.signal.throwIfAborted();
    while (snippet === undefined) {
      const { done, value } = await raceWithSignal(reader.read(), operation.signal);
      if (done) {
        text += decoder.decode();
        completed = true;
        snippet = text.length === 0 ? '<empty>' : text;
        break;
      }
      reads++;
      if (value.byteLength === 0) {
        emptyChunks++;
        if (emptyChunks > BODY_SNIPPET_MAX_EMPTY_CHUNKS) {
          throw new Error(`Upstream stream diagnostic exceeded ${BODY_SNIPPET_MAX_EMPTY_CHUNKS} empty body chunks`);
        }
      } else {
        armIdleTimer();
      }
      const remainingBytes = BODY_SNIPPET_BYTES - capturedBytes;
      const captured = value.subarray(0, Math.max(remainingBytes, 0));
      capturedBytes += captured.byteLength;
      text += decoder.decode(captured, { stream: true });
      if (captured.byteLength < value.byteLength || text.length > BODY_SNIPPET_CHARS) {
        snippet = `${text.slice(0, BODY_SNIPPET_CHARS)}...[truncated]`;
        break;
      }
      if (reads % BODY_SNIPPET_TIMER_YIELD_INTERVAL === 0) {
        await raceWithSignal(yieldToTimers(), operation.signal);
      }
    }
  } catch (error) {
    failure = { error };
  } finally {
    clearTimeout(totalTimer);
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    callerSignal?.removeEventListener('abort', onCallerAbort);
    operation.signal.removeEventListener('abort', onOperationAbort);

    if (!completed) {
      cancelReader(failure?.error);
      const cancellationFailure = await observeImmediateCancellation(cancellation!);
      if (cancellationFailure && cancellationFailure.error !== failure?.error) cleanupFailures.push(cancellationFailure.error);
      if (!cancellation!.settled) reportLateCancellationFailure(cancellation!, failure?.error);
    }
    try {
      reader.releaseLock();
    } catch (error) {
      cleanupFailures.push(error);
    }
  }

  if (failure) {
    throw aggregateFailure(failure.error, cleanupFailures, 'Upstream stream diagnostic read failed');
  }
  return cleanupFailures.length === 0
    ? { text: snippet! }
    : { text: snippet!, cleanupFailure: aggregateCleanupFailures(cleanupFailures) };
};

const streamRequiredError = (response: Response, contentType: string, snippet: string, cause?: unknown): Error =>
  new Error(
    `Upstream returned ${response.status} with content-type "${contentType || 'unknown'}" but stream is required (provider must force stream=true and return text/event-stream when response.ok). Body: ${snippet}`,
    cause === undefined ? undefined : { cause },
  );

const carriesCause = (failure: unknown, cause: unknown): boolean =>
  failure === cause || (failure instanceof Error && failure.cause === cause);

// A 2xx non-SSE upstream is a provider-contract violation: every streaming
// endpoint is called with stream=true. The throw bubbles to the target
// boundary, which turns it into a 502. The upstream's body (or a snippet
// of it) is folded into the error message so what the upstream actually
// returned reaches the operator instead of being discarded — content-type
// "unknown" with no body context is otherwise impossible to debug.
export const streamingProviderCall = async <TEvent>(
  upstreamFetch: Promise<Response>,
  parser: ProviderStreamParser<TEvent>,
  modelKey: string,
  signal: AbortSignal | undefined,
): Promise<ProviderStreamResult<TEvent>> => {
  const response = await upstreamFetch;
  if (!response.ok) {
    return { ok: false, response, modelKey };
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (!response.body || !isEventStreamMediaType(contentType)) {
    if (!response.body) {
      signal?.throwIfAborted();
      throw streamRequiredError(response, contentType, '<empty>');
    }
    let snippet: BodySnippet;
    try {
      snippet = await readBodySnippet(response, signal);
    } catch (cause) {
      if (signal?.aborted && carriesCause(cause, signal.reason)) throw cause;
      throw streamRequiredError(response, contentType, '<unreadable>', cause);
    }
    if (signal?.aborted) {
      throw snippet.cleanupFailure === undefined
        ? signal.reason
        : aggregateFailure(signal.reason, [snippet.cleanupFailure], 'Upstream stream diagnostic cleanup failed');
    }
    throw streamRequiredError(response, contentType, snippet.text, snippet.cleanupFailure);
  }
  return { ok: true, events: parser(response.body, { signal }), modelKey, headers: response.headers };
};
