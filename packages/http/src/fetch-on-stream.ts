// Run an HTTP/1.1 request over an already-established duplex byte stream.

import { concat, utf8Bytes } from './bytes.ts';
import { HttpProtocolError } from './errors.ts';
import { TCHAR, validateFieldValueBytes, validateRequestTargetBytes } from './grammar.ts';
import { parseHttpResponse, toWebResponse } from './parser.ts';
import type { DuplexStream, HttpRequest, ReplayableBody } from './types.ts';

// Plaintext chunk size used when streaming the request body to the writer.
// Each writer.write() maps 1:1 to one record on a record-framed writer, so
// this tunes the trade-off between per-record overhead and per-write
// microtask cost.
const BODY_WRITE_CHUNK_SIZE = 16384;

const bodyLength = (body: HttpRequest['body']): number =>
  body instanceof Uint8Array ? body.byteLength : body?.contentLength ?? 0;

const writeBytes = async (writer: WritableStreamDefaultWriter<Uint8Array>, bytes: Uint8Array): Promise<void> => {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const chunk = bytes.subarray(offset, Math.min(offset + BODY_WRITE_CHUNK_SIZE, bytes.byteLength));
    await writer.write(chunk);
    offset += chunk.byteLength;
  }
};

const writeStreamBody = async (
  writer: WritableStreamDefaultWriter<Uint8Array>,
  body: ReplayableBody,
): Promise<void> => {
  const reader = body.open().getReader();
  let written = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new TypeError('HTTP request body stream yielded a non-Uint8Array chunk');
      written += value.byteLength;
      if (written > body.contentLength) throw new RangeError('HTTP request body stream exceeded its declared content length');
      await writeBytes(writer, value);
    }
    if (written !== body.contentLength) throw new RangeError('HTTP request body stream ended before its declared content length');
  } catch (error) {
    try {
      await reader.cancel(error);
    } catch {
      // Body transmission is the causal failure; cancellation is cleanup and
      // must not replace the error the caller can act on.
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
};

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
  //   - drop Content-Length / Transfer-Encoding — byte bodies supply their
  //     measured length and stream factories declare it, so caller framing
  //     cannot be the source of truth at this layer.
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
  const bodyLen = bodyLength(request.body);
  if (!Number.isSafeInteger(bodyLen) || bodyLen < 0) throw new RangeError('HTTP request body content length must be a non-negative safe integer');
  if (request.body !== undefined) headers['Content-Length'] = String(bodyLen);

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
    if (request.body instanceof Uint8Array) {
      await writeBytes(writer, request.body);
    } else if (request.body !== undefined) {
      await writeStreamBody(writer, request.body);
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
