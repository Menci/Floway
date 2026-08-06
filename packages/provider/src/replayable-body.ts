const STREAM_CHUNK_BYTES = 64 * 1024;
// Cleanup is bounded so a broken runtime stream cannot pin the request after
// native fetch has already failed. Five seconds preserves most of Workers'
// post-disconnect grace period for the gateway's remaining finalizers.
// https://github.com/cloudflare/cloudflare-docs/blob/f8ac0aa6d9ef268d442865225c786753aa1332af/src/content/docs/workers/platform/limits.mdx#L152-L168
const NATIVE_FETCH_CLEANUP_DEADLINE_MS = 5_000;

type CleanupOutcome =
  | { readonly type: 'settled' }
  | { readonly type: 'failed'; readonly error: unknown };

class NativeFetchCleanupTimeoutError extends Error {
  readonly operationIndex: number;
  readonly timeoutMs: number;

  constructor(operationIndex: number) {
    super(`Native fetch cleanup operation ${operationIndex} did not settle within ${NATIVE_FETCH_CLEANUP_DEADLINE_MS}ms`);
    this.name = 'NativeFetchCleanupTimeoutError';
    this.operationIndex = operationIndex;
    this.timeoutMs = NATIVE_FETCH_CLEANUP_DEADLINE_MS;
  }
}

const observeCleanup = (operation: () => void | PromiseLike<void>): Promise<CleanupOutcome> =>
  Promise.resolve().then(operation).then(
    () => ({ type: 'settled' }),
    error => ({ type: 'failed', error }),
  );

const collectDistinctCleanupFailures = async (
  outcomes: readonly Promise<CleanupOutcome>[],
  primary: unknown,
): Promise<readonly unknown[]> => {
  const deadline = Date.now() + NATIVE_FETCH_CLEANUP_DEADLINE_MS;
  const failures: unknown[] = [];
  const append = (failure: unknown): void => {
    if (Object.is(failure, primary) || failures.some(existing => Object.is(existing, failure))) return;
    failures.push(failure);
  };
  for (let operationIndex = 0; operationIndex < outcomes.length; operationIndex++) {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<{ readonly type: 'timeout' }>(resolve => {
      timeoutId = setTimeout(
        () => resolve({ type: 'timeout' }),
        Math.max(0, deadline - Date.now()),
      );
    });
    const result = await Promise.race([outcomes[operationIndex]!, timeout]);
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    if (result.type === 'failed') append(result.error);
    else if (result.type === 'timeout') append(new NativeFetchCleanupTimeoutError(operationIndex));
  }
  return failures;
};

export interface ReplayableBodySource {
  // Segment views transfer into the request. The array shape is frozen, but
  // callers must not mutate their bytes after transfer; a runtime fetch may
  // resolve response headers before it finishes pumping the request body.
  readonly segments: readonly Uint8Array[];
  readonly byteLength: number;
}

const sources = new WeakMap<ReadableStream<Uint8Array>, ReplayableBodySource>();

const assertSource = (segments: readonly Uint8Array[]): ReplayableBodySource => {
  let byteLength = 0;
  for (const segment of segments) {
    byteLength += segment.byteLength;
    if (!Number.isSafeInteger(byteLength)) throw new RangeError('Replayable body byte length exceeds Number.MAX_SAFE_INTEGER');
  }
  return Object.freeze({ segments: Object.freeze([...segments]), byteLength });
};

export const validateReplayableBodySource = (source: ReplayableBodySource): ReplayableBodySource => {
  let byteLength = 0;
  for (const segment of source.segments) {
    byteLength += segment.byteLength;
    if (!Number.isSafeInteger(byteLength)) throw new RangeError('Replayable body byte length exceeds Number.MAX_SAFE_INTEGER');
  }
  if (byteLength !== source.byteLength) throw new RangeError('Replayable body byte length does not match its segments');
  return source;
};

const streamFromSource = (source: ReplayableBodySource): ReadableStream<Uint8Array> => {
  let segmentIndex = 0;
  let segmentOffset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      while (segmentIndex < source.segments.length) {
        const segment = source.segments[segmentIndex]!;
        if (segmentOffset >= segment.byteLength) {
          segmentIndex += 1;
          segmentOffset = 0;
          continue;
        }
        const end = Math.min(segment.byteLength, segmentOffset + STREAM_CHUNK_BYTES);
        controller.enqueue(segment.subarray(segmentOffset, end));
        segmentOffset = end;
        return;
      }
      controller.close();
    },
  }, { highWaterMark: 0 });
  sources.set(stream, source);
  return stream;
};

export const createReplayableBody = (segments: readonly Uint8Array[]): ReadableStream<Uint8Array> =>
  streamFromSource(assertSource(segments));

export const replayableBodyStream = (source: ReplayableBodySource): ReadableStream<Uint8Array> => {
  return streamFromSource(validateReplayableBodySource(source));
};

export const replayableBodySource = (body: BodyInit | null | undefined): ReplayableBodySource | null =>
  body instanceof ReadableStream ? sources.get(body) ?? null : null;

// Undici rejects a ReadableStream request body without duplex='half'.
// https://github.com/nodejs/undici/blob/aa33b19549ef5c37b73599a6deba768e85f46f92/lib/web/fetch/request.js#L535-L542
type DuplexRequestInit = RequestInit & { duplex: 'half' };

interface FixedLengthStreamLike {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
}

type FixedLengthStreamConstructor = new (expectedLength: number) => FixedLengthStreamLike;

const fixedLengthStreamConstructor = (): FixedLengthStreamConstructor | null => {
  const candidate = Reflect.get(globalThis, 'FixedLengthStream');
  return typeof candidate === 'function' ? candidate as FixedLengthStreamConstructor : null;
};

export const nativeFetchInit = (init: RequestInit): RequestInit => {
  const headers = new Headers(init.headers);
  headers.delete('transfer-encoding');
  if (!(init.body instanceof ReadableStream)) {
    // Fetch owns framing for ordinary BodyInit shapes. Retaining a caller's
    // Content-Length makes Node's bundled fetch append its derived length, and
    // an installed newer Undici dispatcher then rejects the combined value as
    // invalid. Removing both transport-owned fields also prevents stale
    // lengths after proxy materialization rebuilds the body.
    // https://github.com/nodejs/undici/blob/01a912e49a50c48009ed2639d2a457a6ec26752a/lib/web/fetch/index.js#L1408-L1435
    // https://github.com/nodejs/undici/blob/aa33b19549ef5c37b73599a6deba768e85f46f92/lib/core/request.js#L498-L505
    headers.delete('content-length');
    return { ...init, headers };
  }
  const source = replayableBodySource(init.body);
  const validated = source === null ? null : validateReplayableBodySource(source);
  if (validated !== null) headers.set('content-length', String(validated.byteLength));
  return {
    ...init,
    body: validated === null ? init.body : streamFromSource(validated),
    headers,
    duplex: 'half',
  } as DuplexRequestInit;
};

export interface PreparedNativeFetch {
  readonly init: RequestInit;
  readonly cancel: (reason: unknown) => Promise<readonly unknown[]>;
}

export const prepareNativeFetch = (init: RequestInit): PreparedNativeFetch => {
  const source = replayableBodySource(init.body);
  const FixedLengthStream = source === null ? null : fixedLengthStreamConstructor();
  if (source === null || FixedLengthStream === null) {
    return { init: nativeFetchInit(init), cancel: () => Promise.resolve([]) };
  }

  // Workers only derives a Content-Length from FixedLengthStream; a manual
  // header on an ordinary ReadableStream is ignored by the runtime.
  // https://github.com/cloudflare/cloudflare-docs/blob/3f39c22a4b2e740e32f611bdd32fb801a2d3e3b8/src/content/docs/workers/runtime-apis/request.mdx#L495-L507
  const validated = validateReplayableBodySource(source);
  // Finish every synchronous validation before allocating and pumping the
  // fixed stream. A malformed header must fail without leaving a locked pump
  // that no PreparedNativeFetch owner exists to cancel.
  const headers = new Headers(init.headers);
  headers.delete('transfer-encoding');
  headers.set('content-length', String(validated.byteLength));
  const fixed = new FixedLengthStream(validated.byteLength);
  const pumpController = new AbortController();
  const pumpSignal = init.signal === null || init.signal === undefined
    ? pumpController.signal
    : AbortSignal.any([init.signal, pumpController.signal]);
  const pumping = streamFromSource(validated).pipeTo(fixed.writable, { signal: pumpSignal });
  // Observe settlement at creation time: fetch may reject before cancellation
  // reaches this pump, and a synchronous destination failure must never spend
  // that gap as an unhandled rejection.
  const pumpingOutcome = pumping.then<CleanupOutcome, CleanupOutcome>(
    () => ({ type: 'settled' }),
    error => ({ type: 'failed', error }),
  );
  let cancellation: Promise<readonly unknown[]> | undefined;
  return {
    init: { ...init, body: fixed.readable, headers, duplex: 'half' } as DuplexRequestInit,
    cancel: reason => cancellation ??= (async () => {
      const readableCancellation = observeCleanup(async () => await fixed.readable.cancel(reason));
      pumpController.abort(reason);
      return await collectDistinctCleanupFailures([readableCancellation, pumpingOutcome], reason);
    })(),
  };
};
