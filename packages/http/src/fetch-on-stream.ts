// Run an HTTP/1.1 request over an already-established duplex byte stream.

import { concat, utf8Bytes } from './bytes.ts';
import { HttpProtocolError } from './errors.ts';
import { TCHAR, validateFieldValueBytes, validateRequestTargetBytes } from './grammar.ts';
import { parseHttpResponse, toWebResponse } from './parser.ts';
import type { DuplexStream, HttpRequest } from './types.ts';

// Plaintext chunk size used when streaming the request body to the writer.
// Each writer.write() maps 1:1 to one record on a record-framed writer, so
// this tunes the trade-off between per-record overhead and per-write
// microtask cost.
const BODY_WRITE_CHUNK_SIZE = 16384;

export const fetchOnStream = async (
  stream: DuplexStream,
  request: HttpRequest,
  prefix?: Uint8Array,
): Promise<Response> => {
  // RFC 9110 §6.4.1: a HEAD response carries no body even when
  // Content-Length is set. Detecting that here is a one-line carve-out,
  // but the chunked/length body parsers below would otherwise hang
  // waiting for body bytes that the server is not sending — so refuse
  // HEAD outright at this layer. Callers that need HEAD can build the
  // response themselves off the headers we'd parse.
  if (request.method.toUpperCase() === 'HEAD') {
    throw new HttpProtocolError(
      'HEAD requests are not supported by this layer',
      'HEAD_REQUEST_REJECTED',
      { rfc: 'RFC 9110 §6.4.1' },
    );
  }

  // RFC 9110 §9.1: the method is a token. The same anti-smuggling rationale
  // as header names applies — a CR/LF/SP smuggled into the method would split
  // the request line and inject a forged head onto the wire.
  if (!TCHAR.test(request.method)) {
    throw new HttpProtocolError(
      `caller-supplied method is not a valid token: ${JSON.stringify(request.method)}`,
      'BAD_HEADERS',
      { rfc: 'RFC 9110 §9.1' },
    );
  }
  validateRequestTargetBytes(
    request.path,
    () => new HttpProtocolError(
      'caller-supplied path is empty',
      'BAD_HEADERS',
      { rfc: 'RFC 9112 §3.2' },
    ),
    hex => new HttpProtocolError(
      `caller-supplied path contains a forbidden byte 0x${hex}`,
      'BAD_HEADERS',
      { rfc: 'RFC 9112 §3.2' },
    ),
  );

  // Normalize the request header block in a single pass:
  //   - drop Content-Length / Transfer-Encoding — the buffered body's
  //     exact length is the source of truth at this layer, and a chunked
  //     encoding from the runtime fetch path would leave the body wrapped
  //     in chunk markers we cannot decode here.
  //   - drop any Connection case-variant — this layer is one-shot per
  //     duplex (we always emit Connection: close below) and a caller-
  //     supplied `keep-alive` would mislead the upstream into reusing a
  //     transport we plan to tear down.
  //   - validate every name/value the caller passes through so a
  //     ${k}: ${v}\r\n serialization can't smuggle a fresh header line
  //     onto the wire.
  // Validation runs before getWriter() so a forbidden byte rejects without
  // ever taking the writer lock — otherwise a pre-write throw would leave
  // the lock pinned and the caller's writable.abort() would TypeError.
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(request.headers)) {
    if (!TCHAR.test(k)) {
      throw new HttpProtocolError(
        `caller-supplied header name is not a valid token: ${JSON.stringify(k)}`,
        'BAD_HEADERS',
        { rfc: 'RFC 9110 §5.6.2' },
      );
    }
    validateFieldValueBytes(v, hex => new HttpProtocolError(
      `caller-supplied header value for ${JSON.stringify(k)} contains a forbidden control byte 0x${hex}`,
      'BAD_HEADERS',
      { rfc: 'RFC 9110 §5.5' },
    ));
    const lk = k.toLowerCase();
    if (lk === 'content-length' || lk === 'transfer-encoding' || lk === 'connection') continue;
    headers[k] = v;
  }
  headers.Connection = 'close';
  // Without Content-Length on a body-bearing request, RFC 9112 §6 has the
  // server treat the message as zero-length — a serialized POST emitted
  // with no framing at all silently loses its body on strict upstreams.
  const bodyLen = request.body?.byteLength ?? 0;
  if (bodyLen > 0) headers['Content-Length'] = String(bodyLen);

  const requestLine = `${request.method} ${request.path} HTTP/1.1\r\n`;
  let head = requestLine;
  for (const [k, v] of Object.entries(headers)) head += `${k}: ${v}\r\n`;
  head += '\r\n';
  const headBytes = utf8Bytes(head);

  const writer = stream.writable.getWriter();
  try {
    if (prefix && prefix.byteLength > 0) {
      await writer.write(concat(prefix, headBytes));
    } else {
      await writer.write(headBytes);
    }
    if (request.body?.byteLength) {
      let off = 0;
      while (off < request.body.byteLength) {
        const slice = request.body.subarray(off, Math.min(off + BODY_WRITE_CHUNK_SIZE, request.body.byteLength));
        await writer.write(slice);
        off += slice.byteLength;
      }
    }
  } finally {
    // Release on every exit so a write rejection doesn't pin the lock —
    // Web Streams errors the stream on rejection but does NOT release the
    // writer, which would then make the caller's writable.abort() fail
    // with "Cannot abort a stream that already has a writer".
    writer.releaseLock();
  }

  return toWebResponse(await parseHttpResponse(stream.readable));
};
