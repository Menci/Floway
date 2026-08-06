// Run an HTTP/1.1 request over an already-established duplex byte stream.

import { collectPromptCleanupFailures, signalAbortReason, startPromptCleanup, type PromptCleanupObservation } from './abort.ts';
import { concat, utf8Bytes } from './bytes.ts';
import { failureWithCleanup } from './cleanup.ts';
import { HttpProtocolError } from './errors.ts';
import { TCHAR, validateFieldValueBytes, validateRequestTargetBytes } from './grammar.ts';
import { parseHttpResponse, toWebResponse } from './parser.ts';
import type { DuplexStream, HttpRequest } from './types.ts';

// Plaintext chunk size used when streaming the request body to the writer.
// Each writer.write() maps 1:1 to one record on a record-framed writer, so
// this tunes the trade-off between per-record overhead and per-write
// microtask cost.
const BODY_WRITE_CHUNK_SIZE = 16384;

const requestBodySegments = (request: HttpRequest): readonly Uint8Array[] => {
  const body = request.body;
  if (body === undefined) return [];
  return body instanceof Uint8Array ? [body] : body;
};

const requestBodyLength = (segments: readonly Uint8Array[]): number => {
  let length = 0;
  for (const segment of segments) {
    length += segment.byteLength;
    if (!Number.isSafeInteger(length)) throw new RangeError('HTTP request body exceeds Number.MAX_SAFE_INTEGER bytes');
  }
  return length;
};

interface FetchOnStreamOptions {
  readonly signal?: AbortSignal;
}

const writeWithSignal = async (
  writer: WritableStreamDefaultWriter<Uint8Array>,
  chunk: Uint8Array,
  signal: AbortSignal | undefined,
): Promise<void> => {
  if (signal === undefined) {
    await writer.write(chunk);
    return;
  }
  if (signal.aborted) throw signalAbortReason(signal);
  type WriteOutcome =
    | { readonly type: 'written' }
    | { readonly type: 'write-error'; readonly error: unknown }
    | { readonly type: 'aborted'; readonly reason: Error };
  let resolveAbort!: (outcome: WriteOutcome) => void;
  let abortCleanup: PromptCleanupObservation | undefined;
  const aborted = new Promise<WriteOutcome>(resolve => { resolveAbort = resolve; });
  const onAbort = (): void => {
    const reason = signalAbortReason(signal);
    abortCleanup = startPromptCleanup(
      'HTTP request writer abort',
      () => writer.abort(reason),
    );
    resolveAbort({ type: 'aborted', reason });
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    const write = Promise.resolve().then(async (): Promise<WriteOutcome> => {
      try {
        await writer.write(chunk);
        return { type: 'written' };
      } catch (error) {
        return { type: 'write-error', error };
      }
    });
    const outcome = await Promise.race([write, aborted]);
    if (outcome.type === 'aborted' || signal.aborted || abortCleanup !== undefined) {
      const reason = outcome.type === 'aborted' ? outcome.reason : signalAbortReason(signal);
      const cleanup = abortCleanup ?? startPromptCleanup(
        'HTTP request writer abort',
        () => writer.abort(reason),
      );
      const cleanupFailures = await collectPromptCleanupFailures([cleanup], reason);
      throw failureWithCleanup(
        reason,
        cleanupFailures,
        'HTTP request abort and writer cleanup both failed',
      );
    }
    if (outcome.type === 'write-error') throw outcome.error;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
};

export const fetchOnStream = async (
  stream: DuplexStream,
  request: HttpRequest,
  prefix?: Uint8Array,
  options: FetchOnStreamOptions = {},
): Promise<Response> => {
  if (options.signal?.aborted) throw signalAbortReason(options.signal);
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
  if (request.method.toUpperCase() === 'CONNECT') {
    throw new HttpProtocolError(
      'CONNECT requests are not supported by this HTTP response layer',
      'CONNECT_REQUEST_REJECTED',
      { rfc: 'RFC 9112 §6.3' },
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
  const headers: Array<[name: string, value: string]> = [];
  let hostCount = 0;
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
    if (lk === 'host') hostCount++;
    headers.push([k, v]);
  }
  if (hostCount !== 1) {
    throw new HttpProtocolError(
      `HTTP/1.1 request requires exactly one Host header; received ${hostCount}`,
      'BAD_HEADERS',
      { rfc: 'RFC 9112 §3.2' },
    );
  }
  headers.push(['Connection', 'close']);
  // Without Content-Length on a body-bearing request, RFC 9112 §6 has the
  // server treat the message as zero-length — a serialized POST emitted
  // with no framing at all silently loses its body on strict upstreams.
  const bodySegments = requestBodySegments(request);
  const bodyLen = requestBodyLength(bodySegments);
  if (bodyLen > 0) headers.push(['Content-Length', String(bodyLen)]);

  const requestLine = `${request.method} ${request.path} HTTP/1.1\r\n`;
  let head = requestLine;
  for (const [k, v] of headers) head += `${k}: ${v}\r\n`;
  head += '\r\n';
  const headBytes = utf8Bytes(head);

  const writer = stream.writable.getWriter();
  try {
    if (prefix && prefix.byteLength > 0) {
      await writeWithSignal(writer, concat(prefix, headBytes), options.signal);
    } else {
      await writeWithSignal(writer, headBytes, options.signal);
    }
    for (const segment of bodySegments) {
      let offset = 0;
      while (offset < segment.byteLength) {
        const slice = segment.subarray(offset, Math.min(offset + BODY_WRITE_CHUNK_SIZE, segment.byteLength));
        await writeWithSignal(writer, slice, options.signal);
        offset += slice.byteLength;
      }
    }
  } finally {
    // Release on every exit so a write rejection doesn't pin the lock —
    // Web Streams errors the stream on rejection but does NOT release the
    // writer, which would then make the caller's writable.abort() fail
    // with "Cannot abort a stream that already has a writer".
    writer.releaseLock();
  }

  return toWebResponse(await parseHttpResponse(stream.readable, options.signal));
};
