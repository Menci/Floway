/**
 * Connect-RPC envelope framing.
 *
 * Cursor's RunSSE / BidiAppend use the gRPC-Web / connect framing: a 5-byte
 * header (1 flag byte + 4 big-endian uint32 length) prefixing each proto
 * payload. RunSSE is a stream of these frames; BidiAppend is a single frame
 * request and a (usually empty) single-frame response.
 *
 * Flag bits:
 *   0x01 — payload gzip-compressed
 *   0x02 — end-stream error (trailer carries grpc-status/message)
 *   0x80 — trailer frame (headers: grpc-status, grpc-message, ...)
 *
 * Workers-clean: Uint8Array + DataView; gzip via DecompressionStream (available
 * on Workers and Node 22+).
 */

export const FLAG_COMPRESSED = 0x01;
export const FLAG_END_STREAM = 0x02;
export const FLAG_TRAILER = 0x80;

/** Wrap a proto payload in a 5-byte connect envelope. */
export function addConnectEnvelope(data: Uint8Array, flags = 0): Uint8Array {
  const result = new Uint8Array(5 + data.length);
  result[0] = flags;
  const length = data.length;
  result[1] = (length >>> 24) & 0xff;
  result[2] = (length >>> 16) & 0xff;
  result[3] = (length >>> 8) & 0xff;
  result[4] = length & 0xff;
  result.set(data, 5);
  return result;
}

export interface ConnectFrame {
  flags: number;
  payload: Uint8Array;
  nextOffset: number;
}

/**
 * Try to read one connect frame starting at `offset` in `buffer`. Returns null
 * when the buffer doesn't yet hold a complete frame — the caller should read
 * more bytes and retry from the same offset.
 */
export function readConnectFrame(buffer: Uint8Array, offset: number): ConnectFrame | null {
  if (offset + 5 > buffer.length) return null;

  const flags = buffer[offset]!;
  const b1 = buffer[offset + 1]!;
  const b2 = buffer[offset + 2]!;
  const b3 = buffer[offset + 3]!;
  const b4 = buffer[offset + 4]!;
  // Unsigned 32-bit big-endian length. Use >>> to keep it non-negative.
  const length = ((b1 << 24) | (b2 << 16) | (b3 << 8) | b4) >>> 0;

  const frameEnd = offset + 5 + length;
  if (frameEnd > buffer.length) return null;

  const payload = buffer.slice(offset + 5, frameEnd);
  return { flags, payload, nextOffset: frameEnd };
}

/** True if a frame's flag byte marks it as a trailer (end-stream metadata). */
export function isTrailerFrame(flags: number): boolean {
  return (flags & FLAG_TRAILER) !== 0;
}

/** True if a frame's payload is gzip-compressed. */
export function isCompressedFrame(flags: number): boolean {
  return (flags & FLAG_COMPRESSED) !== 0;
}

/** Parse a trailer frame's header block into a lowercased key->value map. */
export function parseTrailerMetadata(trailer: string): Record<string, string> {
  const meta: Record<string, string> = {};

  for (const rawLine of trailer.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;

    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (!key) continue;
    meta[key] = value;
  }

  return meta;
}

/**
 * Gunzip a payload using the Web Streams DecompressionStream. No-op on empty
 * input. Throws if the runtime lacks DecompressionStream.
 */
export async function decompressGzip(payload: Uint8Array): Promise<Uint8Array> {
  if (payload.length === 0) return payload;
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  // Copy into a fresh ArrayBuffer-backed view so the writable's BufferSource
  // constraint is satisfied regardless of the caller's backing storage
  // (SharedArrayBuffer-backed views fail the ArrayBuffer-typed buffer check).
  void writer.write(new Uint8Array(payload));
  await writer.close();

  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.length;
    }
  }

  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}
