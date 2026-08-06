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

export const readRequestBody = async (c: Context, options: ReadRequestBodyOptions = {}): Promise<RequestBody> => {
  const maxBytes = options.maxBytes ?? MAX_BUFFERED_REQUEST_BODY_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new TypeError(`readRequestBody maxBytes must be a non-negative safe integer, got ${maxBytes}`);
  }
  if (c.req.raw.body === null) return { capturedBytes: new Uint8Array(), streamError: null };

  const declared = declaredContentLength(c);
  if (declared !== null && declared > maxBytes) {
    return cancelOversizedBody(c.req.raw.body, new RequestBodyTooLargeError(maxBytes));
  }

  const reader = c.req.raw.body.getReader();
  let bytes = new Uint8Array();
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const required = length + value.byteLength;
      if (required > maxBytes) {
        const error = new RequestBodyTooLargeError(maxBytes);
        try {
          void reader.cancel(error).catch(() => {});
        } catch {
          // The bounded-size error owns this response even if teardown fails.
        }
        throw error;
      }
      if (required > bytes.byteLength) {
        const doubled = bytes.byteLength === 0 ? 16 * 1024 : bytes.byteLength * 2;
        const capacity = Math.min(maxBytes, Math.max(required, doubled));
        const grown = new Uint8Array(capacity);
        grown.set(bytes.subarray(0, length));
        bytes = grown;
      }
      bytes.set(value, length);
      length = required;
    }
    return { capturedBytes: bytes.subarray(0, length), streamError: null };
  } catch (err) {
    if (err instanceof RequestBodyTooLargeError) throw err;
    return { capturedBytes: bytes.subarray(0, length), streamError: normalizedStreamError(err) };
  }
};
