import type { Context } from 'hono';

import { MAX_BUFFERED_REQUEST_BODY_BYTES, RequestBodyTooLargeError } from '../../middleware/request-body-limit.ts';

// Inbound body bytes the handler reads once and forwards into the dump
// accumulator (so the handler's payload parser AND the dump see the same
// bytes without a second read). `streamError` surfaces a client mid-upload
// abort as a non-null message; the dump records it as `meta.error`.
export interface RequestBody {
  capturedBytes: Uint8Array;
  readonly streamError: string | null;
}

export interface OwnedRequestBody {
  bytes: Uint8Array;
  readonly streamError: string | null;
}

export const completeRequestBodyBytes = (source: RequestBody): Uint8Array =>
  source.streamError === null ? source.capturedBytes : new Uint8Array();

// Transfers the buffer only after its destination has been constructed. A
// synchronous context-construction failure leaves the bytes on `source`, so
// an error fallback can still open the request dump from the original body.
export const transferRequestBody = <T>(source: RequestBody, owner: (body: OwnedRequestBody) => T): T => {
  const result = owner({ bytes: source.capturedBytes, streamError: source.streamError });
  source.capturedBytes = new Uint8Array();
  return result;
};

// Transfers the byte buffer into the request context after payload parsing.
// Async HTTP handlers keep their local RequestBody across the upstream wait;
// clearing that slot prevents it from retaining the full wire body after the
// dump pipeline (when enabled) has started preparing its own representation.
export const takeRequestBody = (source: RequestBody): OwnedRequestBody =>
  transferRequestBody(source, owned => owned);

// Reads the inbound body in full into a Uint8Array; the handler parses its
// payload off the same buffer so the wire body is consumed exactly once. A
// read failure (client aborted upload) surfaces as a non-null `streamError`
// instead of throwing — the dump captures the partial payload + the cause,
// the handler still sees a parse error of its own.
interface ReadRequestBodyOptions {
  readonly maxBytes?: number;
  readonly maxBytesWithoutContentLength?: number;
}

const normalizedStreamError = (error: unknown): string => {
  let message: string;
  try {
    message = error instanceof Error ? error.message : String(error);
  } catch {
    message = 'Request body stream failed with an unprintable error';
  }
  const oneLine = message.replace(/\s+/g, ' ').trim();
  return oneLine.length > 500 ? `${oneLine.slice(0, 497)}…` : oneLine;
};

const declaredContentLength = (c: Context): number | null => {
  const raw = c.req.header('content-length');
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

const cancelOversizedBody = (body: ReadableStream<Uint8Array>, error: RequestBodyTooLargeError): never => {
  try {
    void body.cancel(error).catch(() => {});
  } catch {
    // The size violation remains the client-visible failure even when the
    // already-broken upload stream rejects cancellation.
  }
  throw error;
};

const coalesceChunks = (chunks: readonly Uint8Array[], byteLength: number): Uint8Array => {
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

export const readRequestBody = async (c: Context, options: ReadRequestBodyOptions = {}): Promise<RequestBody> => {
  const maxBytes = options.maxBytes ?? MAX_BUFFERED_REQUEST_BODY_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new TypeError(`readRequestBody maxBytes must be a non-negative safe integer, got ${maxBytes}`);
  }
  const maxBytesWithoutContentLength = options.maxBytesWithoutContentLength ?? maxBytes;
  if (!Number.isSafeInteger(maxBytesWithoutContentLength)
    || maxBytesWithoutContentLength < 0
    || maxBytesWithoutContentLength > maxBytes) {
    throw new TypeError(`readRequestBody maxBytesWithoutContentLength must be a non-negative safe integer no greater than maxBytes, got ${maxBytesWithoutContentLength}`);
  }
  if (c.req.raw.body === null) return { capturedBytes: new Uint8Array(), streamError: null };

  const declared = declaredContentLength(c);
  let usesUndeclaredLimit = declared === null;
  let effectiveMaxBytes = usesUndeclaredLimit ? maxBytesWithoutContentLength : maxBytes;
  const sizeError = (): RequestBodyTooLargeError => new RequestBodyTooLargeError(
    effectiveMaxBytes,
    usesUndeclaredLimit && maxBytesWithoutContentLength < maxBytes ? maxBytes : null,
  );
  if (declared !== null && declared > maxBytes) {
    return cancelOversizedBody(c.req.raw.body, sizeError());
  }

  const reader = c.req.raw.body.getReader();
  // A validated Content-Length lets the normal HTTP path allocate its final
  // owner exactly once. Unknown-length uploads retain the runtime's bounded
  // chunks and coalesce once at the end instead of geometrically reallocating
  // and briefly retaining both an old and a new near-limit buffer.
  let declaredBytes: Uint8Array | null = null;
  let chunks: Uint8Array[] | null = declared === null ? [] : null;
  let length = 0;
  const capturedBytes = (): Uint8Array => {
    if (chunks !== null) return coalesceChunks(chunks, length);
    if (declaredBytes === null) return new Uint8Array();
    if (length === declaredBytes.byteLength) return declaredBytes;
    // Keep a view of an over-declared allocation. Copying a 49 MiB short body
    // out of a 52 MiB owner would create the very near-limit overlap this path
    // exists to avoid; downstream multipart and replayable segments borrow the
    // same backing and release it after request finalization.
    return declaredBytes.subarray(0, length);
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength === 0) continue;
      const required = length + value.byteLength;
      if (!usesUndeclaredLimit && required > declared!) {
        // Once observed bytes contradict Content-Length, its larger fixed-size
        // allowance is no longer trustworthy. Switch before retaining the
        // offending chunk so a forged tiny declaration cannot unlock a 52 MiB
        // chunked/coalesced path.
        usesUndeclaredLimit = true;
        effectiveMaxBytes = maxBytesWithoutContentLength;
      }
      if (required > effectiveMaxBytes) {
        const error = sizeError();
        try {
          void reader.cancel(error).catch(() => {});
        } catch {
          // The bounded-size error owns this response even if teardown fails.
        }
        throw error;
      }
      if (chunks === null && required <= declared!) {
        if (length === 0
          && value.byteLength === declared
          && value.byteOffset === 0
          && value.buffer.byteLength === declared) {
          // Workerd and Node can deliver a fixed-length request as one owning
          // chunk. Adopt it directly so a 49 MiB upload never overlaps an
          // equally large preallocation merely to copy identical bytes.
          declaredBytes = value;
        } else {
          declaredBytes ??= new Uint8Array(declared!);
          declaredBytes.set(value, length);
        }
      } else {
        // A body exceeding its declared length should normally be rejected by
        // the HTTP runtime. Preserve the prior tolerant capture behavior for a
        // synthetic or non-conforming Request by switching to the same
        // coalesce-once path used for unknown lengths.
        if (chunks === null) {
          chunks = length === 0 ? [] : [declaredBytes!.subarray(0, length)];
          declaredBytes = null;
        }
        chunks.push(value);
      }
      length = required;
    }
    return { capturedBytes: capturedBytes(), streamError: null };
  } catch (err) {
    if (err instanceof RequestBodyTooLargeError) throw err;
    return { capturedBytes: capturedBytes(), streamError: normalizedStreamError(err) };
  }
};
