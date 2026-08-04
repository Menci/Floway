import { base64 } from '@scure/base';

// Tiny byte-buffer primitives. Buffers come in from a transport-owned
// ReadableStream — those buffers may be pooled or reused by the runtime
// (most visibly on Node), so anything we enqueue downstream or retain past
// the next read needs to own its memory.

/**
 * Allocate a fresh ArrayBuffer-backed Uint8Array and copy `u` into it.
 * Detaches the resulting buffer from any transport-owned backing storage
 * so the consumer can hold or mutate it safely.
 */
export const copy = (u: Uint8Array): Uint8Array<ArrayBuffer> => {
  const r = new Uint8Array(u.byteLength);
  r.set(u);
  return r;
};

/**
 * Concatenate two byte buffers into a freshly-allocated ArrayBuffer-backed
 * Uint8Array. The empty-input branches go through `copy()` so the returned
 * buffer is always detached from the inputs' backing storage — accumulators
 * (`buf = concat(buf, value)` starting from a zero-length buf) can therefore
 * hold the result past the next transport read without risking aliasing.
 */
export const concat = (a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> => {
  if (a.byteLength === 0) return copy(b);
  if (b.byteLength === 0) return copy(a);
  const r = new Uint8Array(a.byteLength + b.byteLength);
  r.set(a, 0);
  r.set(b, a.byteLength);
  return r;
};

/**
 * Locate a CR/LF/CR/LF sequence starting at index `from` — the HTTP/1.1
 * header-section terminator (RFC 9112 §2.2). Returns the index of the
 * first CR, or -1 if the buffer doesn't contain a full terminator yet.
 *
 * The `from` resume index lets a drip-fed accumulator avoid rescanning
 * the prefix on every read: a caller that already searched up to
 * `buf.byteLength` then concats more bytes can pass
 * `Math.max(0, prevByteLength - 3)` to re-examine only the tail where a
 * partial terminator could have started straddling the seam. Without it
 * the per-read search is O(n) on the whole buffer, turning a 1-byte
 * drip up to the 64 KiB header cap into O(n²).
 */
export const findDoubleCrlfFrom = (buf: Uint8Array, from: number): number => {
  for (let i = from; i + 3 < buf.byteLength; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a && buf[i + 2] === 0x0d && buf[i + 3] === 0x0a) return i;
  }
  return -1;
};

/**
 * UTF-8-encode a string. Short enough to use inline at call sites without
 * each caller holding its own TextEncoder.
 */
export const utf8Bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

export const base64EncodeBytes = (bytes: Uint8Array): string => base64.encode(bytes);
