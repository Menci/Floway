// HTTP/1.1 chunked transfer-encoding decoder (RFC 9112 §7.1). The parser
// owns the reader once handed in; cancelling the returned stream cancels
// the underlying reader.

import { concat, copy } from './bytes.ts';
import { HttpProtocolError } from './errors.ts';
import { ASCII_DECODER, TCHAR, decodeHttp1Head, trimFieldValueOws, validateFieldValueBytes } from './grammar.ts';

export const decodeChunked = (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  head: Uint8Array,
): ReadableStream<Uint8Array> => {
  let buf = head;
  // `findCrlfFrom` is otherwise O(n) per call across the whole buffer; on
  // a stream of small chunks that turns into O(n²) total work. We track
  // how far we've already scanned so each new search resumes where the
  // previous one left off.
  let scanFrom = 0;
  let state: 'size' | 'data' | 'after-data-crlf' | 'trailers' = 'size';
  let need = 0;
  // Bound how much the trailer block can grow before we give up. Trailers
  // are unusual in practice; 64 KiB matches the response-header cap.
  const MAX_TRAILERS_BYTES = 64 * 1024;
  // Bound the chunk-size line (size hex + extensions + CRLF). Real chunk
  // sizes never need more than a handful of hex digits; an unboundedly
  // long extension is the only way to reach this cap, and it's a DoS.
  const MAX_CHUNK_SIZE_LINE = 1024;
  let trailerBytesSeen = 0;
  let growingStorage: Uint8Array | null = null;
  const appendGrowing = (chunk: Uint8Array): void => {
    const currentLength = buf.byteLength;
    const required = currentLength + chunk.byteLength;
    const canReuse = growingStorage !== null
      && buf.buffer === growingStorage.buffer
      && buf.byteOffset === 0
      && growingStorage.byteLength >= required;
    if (!canReuse) {
      const next = new Uint8Array(Math.max(1024, required, currentLength * 2));
      next.set(buf);
      growingStorage = next;
    }
    growingStorage!.set(chunk, currentLength);
    buf = growingStorage!.subarray(0, required);
  };
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    try { reader.releaseLock(); } catch { /* lock already released */ }
  };
  const fail = async (
    controller: ReadableStreamDefaultController<Uint8Array>,
    error: HttpProtocolError,
  ): Promise<void> => {
    controller.error(error);
    try { await reader.cancel(error); } catch { /* reader already cancelled */ } finally { release(); }
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (true) {
          if (state === 'size') {
            const idx = findCrlfFrom(buf, scanFrom);
            if (idx < 0) {
              if (buf.byteLength > MAX_CHUNK_SIZE_LINE) {
                await fail(controller, new HttpProtocolError(
                  `chunked: size line exceeded ${MAX_CHUNK_SIZE_LINE} bytes`,
                  'CHUNK_TOO_LONG',
                ));
                return;
              }
              scanFrom = Math.max(0, buf.byteLength - 1);
              const more = await reader.read();
              if (more.done) {
                await fail(controller, new HttpProtocolError('chunked: EOF in size', 'EOF'));
                return;
              }
              appendGrowing(more.value);
              continue;
            }
            if (idx > MAX_CHUNK_SIZE_LINE) {
              await fail(controller, new HttpProtocolError(
                `chunked: size line exceeded ${MAX_CHUNK_SIZE_LINE} bytes`,
                'CHUNK_TOO_LONG',
              ));
              return;
            }
            const sizeLine = ASCII_DECODER.decode(buf.subarray(0, idx));
            const semi = sizeLine.indexOf(';');
            const hex = semi < 0 ? sizeLine : sizeLine.slice(0, semi);
            // Strict hex validation. parseInt('1f garbage', 16) returns 31 —
            // a smuggling-adjacent path. Require a pure run of hex digits;
            // chunk extensions (after the `;`) are dropped by the slice
            // above before we get here.
            if (!/^[0-9a-fA-F]+$/.test(hex)) {
              await fail(controller, new HttpProtocolError(
                `chunked: bad size line ${JSON.stringify(sizeLine)}`,
                'CHUNK_BAD_SIZE',
              ));
              return;
            }
            if (semi >= 0 && !validChunkExtensions(sizeLine.slice(semi))) {
              await fail(controller, new HttpProtocolError(
                `chunked: malformed extension in size line ${JSON.stringify(sizeLine)}`,
                'CHUNK_BAD_SIZE',
              ));
              return;
            }
            // The regex bounds the digits to hex but not the magnitude.
            // Reject both values wider than the protocol's 64-bit field and
            // values JavaScript cannot represent exactly; an imprecise `need`
            // would lose the body boundary and stream upstream bytes unbounded.
            const exactSize = BigInt(`0x${hex}`);
            if (exactSize > BigInt(Number.MAX_SAFE_INTEGER)) {
              await fail(controller, new HttpProtocolError(
                'chunked: size exceeds the exact integer range',
                'CHUNK_BAD_SIZE',
              ));
              return;
            }
            need = Number(exactSize);
            buf = buf.subarray(idx + 2);
            scanFrom = 0;
            state = need === 0 ? 'trailers' : 'data';
          } else if (state === 'data') {
            if (buf.byteLength === 0) {
              const more = await reader.read();
              if (more.done) {
                await fail(controller, new HttpProtocolError('chunked: EOF mid-data', 'EOF'));
                return;
              }
              buf = copy(more.value);
              continue;
            }
            const take = Math.min(buf.byteLength, need);
            controller.enqueue(copy(buf.subarray(0, take)));
            buf = buf.subarray(take);
            need -= take;
            if (need === 0) state = 'after-data-crlf';
            return;
          } else if (state === 'after-data-crlf') {
            while (buf.byteLength < 2) {
              const more = await reader.read();
              if (more.done) {
                await fail(controller, new HttpProtocolError(
                  'chunked: EOF before CRLF after data',
                  'EOF',
                ));
                return;
              }
              buf = concat(buf, more.value);
            }
            if (buf[0] !== 0x0d || buf[1] !== 0x0a) {
              await fail(controller, new HttpProtocolError(
                'chunked: missing CRLF after data',
                'CHUNK_BAD_SIZE',
              ));
              return;
            }
            buf = buf.subarray(2);
            scanFrom = 0;
            state = 'size';
          } else if (state === 'trailers') {
            const idx = findCrlfFrom(buf, scanFrom);
            if (idx < 0) {
              // Bound the unconsumed buffer + already-consumed lines against
              // the cap, rather than accumulating buf.byteLength per iteration
              // (which double-counts the same bytes on every drip-fed read and
              // collapses the effective cap to O(sqrt(MAX_TRAILERS_BYTES))).
              if (trailerBytesSeen + buf.byteLength > MAX_TRAILERS_BYTES) {
                await fail(controller, new HttpProtocolError(
                  `chunked: trailers exceeded ${MAX_TRAILERS_BYTES} bytes`,
                  'TRAILERS_TOO_LONG',
                ));
                return;
              }
              scanFrom = Math.max(0, buf.byteLength - 1);
              const more = await reader.read();
              if (more.done) {
                await fail(controller, new HttpProtocolError('chunked: EOF in trailers', 'EOF'));
                return;
              }
              appendGrowing(more.value);
              continue;
            }
            if (idx === 0) {
              if (buf.byteLength > 2) {
                await fail(controller, new HttpProtocolError(
                  `chunked: ${buf.byteLength - 2} trailing bytes after final terminator`,
                  'TRAILING_BODY_BYTES',
                ));
                return;
              }
              controller.close();
              try { await reader.cancel(); } catch { /* reader already cancelled */ } finally { release(); }
              return;
            }
            validateTrailerLine(buf.subarray(0, idx));
            trailerBytesSeen += idx + 2;
            if (trailerBytesSeen > MAX_TRAILERS_BYTES) {
              await fail(controller, new HttpProtocolError(
                `chunked: trailers exceeded ${MAX_TRAILERS_BYTES} bytes`,
                'TRAILERS_TOO_LONG',
              ));
              return;
            }
            buf = buf.subarray(idx + 2);
            scanFrom = 0;
          }
        }
      } catch (error) {
        try { await reader.cancel(error); } catch { /* reader already cancelled */ } finally { release(); }
        throw error;
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason); } catch { /* reader already cancelled */ } finally { release(); }
    },
  });
};

const isTchar = (c: string): boolean => TCHAR.test(c);

const validChunkExtensions = (extensions: string): boolean => {
  let offset = 0;
  while (offset < extensions.length) {
    if (extensions[offset++] !== ';') return false;
    const nameStart = offset;
    while (offset < extensions.length && isTchar(extensions[offset]!)) offset++;
    if (offset === nameStart) return false;
    if (extensions[offset] !== '=') continue;
    offset++;
    if (extensions[offset] === '"') {
      offset++;
      let closed = false;
      while (offset < extensions.length) {
        const c = extensions.charCodeAt(offset++);
        if (c === 0x22) {
          closed = true;
          break;
        }
        if (c === 0x5c) {
          if (offset >= extensions.length) return false;
          const escaped = extensions.charCodeAt(offset++);
          if (escaped !== 0x09 && (escaped < 0x20 || escaped === 0x7f)) return false;
        } else if (c !== 0x09 && (c < 0x20 || c === 0x7f)) {
          return false;
        }
      }
      if (!closed) return false;
    } else {
      const valueStart = offset;
      while (offset < extensions.length && isTchar(extensions[offset]!)) offset++;
      if (offset === valueStart) return false;
    }
  }
  return true;
};

const validateTrailerLine = (bytes: Uint8Array): void => {
  const line = decodeHttp1Head(bytes);
  const colon = line.indexOf(':');
  const name = colon < 0 ? '' : line.slice(0, colon);
  if (!TCHAR.test(name)) {
    throw new HttpProtocolError(
      `chunked: malformed trailer field ${JSON.stringify(line)}`,
      'BAD_HEADERS',
      { rfc: 'RFC 9112 §7.1.2' },
    );
  }
  const value = trimFieldValueOws(line.slice(colon + 1));
  validateFieldValueBytes(value, hex => new HttpProtocolError(
    `chunked: forbidden control byte 0x${hex} in trailer ${JSON.stringify(name)}`,
    'BAD_HEADERS',
    { rfc: 'RFC 9110 §5.5' },
  ));
};

const findCrlfFrom = (buf: Uint8Array, from: number): number => {
  for (let i = from; i + 1 < buf.byteLength; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a) return i;
  }
  return -1;
};
