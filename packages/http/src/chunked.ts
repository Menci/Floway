// HTTP/1.1 chunked transfer-encoding decoder (RFC 9112 §7.1). The parser
// owns the reader once handed in; cancelling the returned stream cancels
// the underlying reader.

import { concat, copy } from './bytes.ts';
import { HttpResponseError } from './errors.ts';
import { ASCII_DECODER } from './grammar.ts';

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
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (true) {
        if (state === 'size') {
          const idx = findCrlfFrom(buf, scanFrom);
          if (idx < 0) {
            if (buf.byteLength > MAX_CHUNK_SIZE_LINE) {
              controller.error(new HttpResponseError(
                `chunked: size line exceeded ${MAX_CHUNK_SIZE_LINE} bytes`,
                'CHUNK_TOO_LONG',
              ));
              return;
            }
            scanFrom = Math.max(0, buf.byteLength - 1);
            const more = await reader.read();
            if (more.done) {
              controller.error(new HttpResponseError('chunked: EOF in size', 'EOF'));
              return;
            }
            buf = concat(buf, more.value);
            continue;
          }
          if (idx > MAX_CHUNK_SIZE_LINE) {
            controller.error(new HttpResponseError(
              `chunked: size line exceeded ${MAX_CHUNK_SIZE_LINE} bytes`,
              'CHUNK_TOO_LONG',
            ));
            return;
          }
          const sizeLine = ASCII_DECODER.decode(buf.subarray(0, idx));
          const semi = sizeLine.indexOf(';');
          const hex = (semi < 0 ? sizeLine : sizeLine.slice(0, semi)).trim();
          // Strict hex validation. parseInt('1f garbage', 16) returns 31 —
          // a smuggling-adjacent path. Require a pure run of hex digits;
          // chunk extensions (after the `;`) are dropped by the slice
          // above before we get here.
          if (!/^[0-9a-fA-F]+$/.test(hex)) {
            controller.error(new HttpResponseError(
              `chunked: bad size line ${JSON.stringify(sizeLine)}`,
              'CHUNK_BAD_SIZE',
            ));
            return;
          }
          // The regex bounds the digits to hex but not the magnitude:
          // MAX_CHUNK_SIZE_LINE allows ~1024 digits, and parseInt overflows
          // to Infinity past ~256 hex digits (2^1028 > Number.MAX_VALUE).
          // An Infinity `need` would let a peer stream upstream bytes
          // unbounded, so cap to a 64-bit-ish chunk size before parsing.
          if (hex.length > 16) {
            controller.error(new HttpResponseError(
              'chunked: size line exceeds 64-bit chunk size',
              'CHUNK_BAD_SIZE',
            ));
            return;
          }
          need = parseInt(hex, 16);
          buf = buf.subarray(idx + 2);
          scanFrom = 0;
          state = need === 0 ? 'trailers' : 'data';
        } else if (state === 'data') {
          if (buf.byteLength === 0) {
            const more = await reader.read();
            if (more.done) {
              controller.error(new HttpResponseError('chunked: EOF mid-data', 'EOF'));
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
              controller.error(new HttpResponseError(
                'chunked: EOF before CRLF after data',
                'EOF',
              ));
              return;
            }
            buf = concat(buf, more.value);
          }
          if (buf[0] !== 0x0d || buf[1] !== 0x0a) {
            controller.error(new HttpResponseError(
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
              controller.error(new HttpResponseError(
                `chunked: trailers exceeded ${MAX_TRAILERS_BYTES} bytes`,
                'TRAILERS_TOO_LONG',
              ));
              return;
            }
            scanFrom = Math.max(0, buf.byteLength - 1);
            const more = await reader.read();
            if (more.done) {
              controller.error(new HttpResponseError('chunked: EOF in trailers', 'EOF'));
              return;
            }
            buf = concat(buf, more.value);
            continue;
          }
          if (idx === 0) {
            controller.close();
            try { await reader.cancel(); } catch { /* reader already cancelled */ }
            return;
          }
          trailerBytesSeen += idx + 2;
          if (trailerBytesSeen > MAX_TRAILERS_BYTES) {
            controller.error(new HttpResponseError(
              `chunked: trailers exceeded ${MAX_TRAILERS_BYTES} bytes`,
              'TRAILERS_TOO_LONG',
            ));
            return;
          }
          buf = buf.subarray(idx + 2);
          scanFrom = 0;
        }
      }
    },
    cancel(reason) {
      reader.cancel(reason).catch(() => {});
    },
  });
};

const findCrlfFrom = (buf: Uint8Array, from: number): number => {
  for (let i = from; i + 1 < buf.byteLength; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a) return i;
  }
  return -1;
};
