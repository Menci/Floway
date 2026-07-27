// HTTP/1.1 response-head parser + body-framing decoders + the
// wire-faithful → Web Response bridge.

import { copy } from './bytes.ts';
import { decodeChunked } from './chunked.ts';
import { HttpProtocolError } from './errors.ts';
import { STATUS_LINE, TCHAR, trimFieldValueOws, validateFieldValueBytes } from './grammar.ts';
import { readHeadSection } from './read-head-section.ts';
import type { RawHttpResponse } from './types.ts';

/**
 * Bridge a wire-faithful {@link RawHttpResponse} to a Web `Response`. The
 * Web `Response` constructor rejects status outside 200..599 and rejects a
 * non-null body for 204/304 — both of which the wire can legitimately
 * carry — so the parser stays a pure wire decoder and this is the single
 * place that maps the parsed shape onto the Fetch standard's constraints.
 *
 * `parseHttpResponse` transparently skips 1xx interim heads, so anything
 * reaching this function should already be a final 2xx..5xx response.
 */
export const toWebResponse = (raw: RawHttpResponse): Response => {
  if (raw.status < 200 || raw.status > 599) {
    // Web Response only models the 200..599 final-status range. A 1xx
    // slipped through is a programmer error inside this package, not an
    // upstream-shaped failure — but the protocol-error class is still the
    // right surface for the caller.
    throw new HttpProtocolError(
      `status ${raw.status} is outside the Web Response constructible range 200..599`,
      'BAD_STATUS_LINE',
      { rfc: 'WHATWG Fetch §response-class' },
    );
  }
  // RFC 9110 §15.3.5 + §15.4.5: 204 No Content and 304 Not Modified MUST
  // NOT carry a body. The Web Response constructor also refuses a non-null
  // body for these statuses, so we cancel the body stream (in case the
  // parser fell back to until-EOF framing on a misbehaving upstream) and
  // construct with `null`.
  if (raw.status === 204 || raw.status === 304) {
    raw.body.cancel().catch(() => {});
    return new Response(null, { status: raw.status, statusText: raw.statusText, headers: raw.headers });
  }
  return new Response(raw.body, { status: raw.status, statusText: raw.statusText, headers: raw.headers });
};

/**
 * Parse an HTTP/1.1 response off a byte-stream reader. Returns a
 * wire-faithful struct rather than a Web `Response`: Response rejects 1xx
 * and refuses to carry a body for 204/304, but those are legal on the
 * wire. Bridge to a Response with {@link toWebResponse} when the caller
 * wants one.
 *
 * 1xx interim heads (100 Continue, 103 Early Hints, …) are read and
 * discarded transparently — RFC 9112 §6 mandates no body on a 1xx, so any
 * subsequent bytes are the next response head, which we re-parse on the
 * spot. The returned struct is always a non-1xx final response.
 */
export const parseHttpResponse = async (readable: ReadableStream<Uint8Array>): Promise<RawHttpResponse> => {
  const reader = readable.getReader();
  let buffer: Uint8Array = new Uint8Array(0);
  // Hand-off contract: on the success path the reader is moved into the body
  // framing stream, which then owns the lock. On every throw before that
  // hand-off the reader must release the lock — otherwise a downstream
  // `stream.readable.cancel(reason)` would land on a still-locked readable
  // and a swallowed TypeError, leaving the underlying transport dangling
  // until GC.
  try {
    while (true) {
      const result = await readResponseHead(reader, buffer);
      buffer = result.remainder;
      if (result.status >= 100 && result.status < 200) {
        // Interim response: no body to frame, no headers to surface. The
        // remainder bytes belong to the next response; loop back into
        // head-parsing with them already buffered.
        continue;
      }
      return finalizeResponse(reader, result);
    }
  } catch (err) {
    try { reader.releaseLock(); } catch { /* lock already released */ }
    throw err;
  }
};

interface ResponseHead {
  status: number;
  statusText: string;
  headers: Headers;
  rawContentLengths: string[];
  rawTransferEncodings: string[];
  remainder: Uint8Array;
}

const readResponseHead = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  preBuffered: Uint8Array,
): Promise<ResponseHead> => {
  // Cap accumulation so a misbehaving upstream that streams headers
  // forever can't exhaust the runtime's heap. 64 KiB is two orders of
  // magnitude over any sane response-header block.
  const HEADER_BUFFER_CAP = 64 * 1024;
  const { statusLine, lines, remainder } = await readHeadSection(reader, preBuffered, {
    maxBytes: HEADER_BUFFER_CAP,
    decodeContext: 'response headers',
    eofError: receivedBytes => new HttpProtocolError(
      `unexpected EOF before headers; got ${receivedBytes} bytes`,
      'EOF',
    ),
    overflowError: maxBytes => new HttpProtocolError(
      `HTTP/1.1 response headers exceeded ${maxBytes} bytes without a terminator`,
      'HEADER_BUFFER_OVERFLOW',
    ),
  });
  // RFC 9112 §4: status-line = HTTP-version SP status-code SP reason-phrase.
  // Two distinct issues to call out separately for a useful error message:
  // (1) the line MUST start with HTTP/1.0 or HTTP/1.1 — llhttp dispatches
  //     HTTP/RTSP/ICE separately, so we surface anything that even begins
  //     `HTTP/` but isn't a supported version with a precise message.
  // (2) the second SP after the status code MUST be followed by a non-SP
  //     reason byte (or the line MUST end immediately — RFC 7230 erratum
  //     4087 permits an empty reason). A double SP between code and reason
  //     would silently absorb the extra SP into the reason in lenient
  //     parsers; llhttp's strict mode rejects it.
  if (!statusLine.startsWith('HTTP/')) {
    throw new HttpProtocolError(
      `status line does not begin with HTTP/: ${JSON.stringify(statusLine)}`,
      'BAD_STATUS_LINE',
      { rfc: 'RFC 9112 §4' },
    );
  }
  const m = STATUS_LINE.exec(statusLine);
  if (!m) {
    throw new HttpProtocolError(
      `bad status line: ${JSON.stringify(statusLine)}`,
      'BAD_STATUS_LINE',
      { rfc: 'RFC 9112 §4' },
    );
  }
  const status = parseInt(m[1]!, 10);
  // RFC 9110 §5.6.3: OWS = *( SP / HTAB ). The reason-phrase grammar
  // forbids leading OWS (enforced by the `\S` first-byte anchor) but
  // greedy `.*` keeps trailing SP/HTAB up to the CRLF, so a misbehaving
  // upstream sending `HTTP/1.1 200 OK   ` would otherwise surface
  // trailing whitespace through statusText. Trim it to match the
  // RawHttpResponse.statusText contract.
  const statusText = m[2]!.replace(/[ \t]+$/, '');

  const respHeaders = new Headers();
  // Track raw header lines so we can validate framing-related fields off
  // the unmerged values. `Headers.get('content-length')` collapses two
  // separate `Content-Length` headers into `5, 5` and `parseInt` then
  // accepts the first value silently — that's the classic HTTP-smuggling
  // shape (RFC 9112 §6.3 mandates rejecting messages with multiple
  // distinct Content-Lengths). Same applies to the chunked detection.
  const rawContentLengths: string[] = [];
  const rawTransferEncodings: string[] = [];
  // Bound the per-response header count alongside the existing 64 KiB
  // header-buffer cap. The byte cap already implies a rough ceiling, but
  // a stream of `A:` lines could stay under 64 KiB while still stuffing
  // tens of thousands of entries into the Headers map.
  const MAX_HEADER_COUNT = 100;
  if (lines.length > MAX_HEADER_COUNT) {
    throw new HttpProtocolError(
      `HTTP/1.1 response has ${lines.length} header lines (max ${MAX_HEADER_COUNT})`,
      'TOO_MANY_HEADERS',
    );
  }
  for (const line of lines) {
    // RFC 9112 §5.2: obs-fold (a continuation line beginning with SP/HTAB)
    // is deprecated and MUST be rejected.
    const first = line.charCodeAt(0);
    if (first === 0x20 || first === 0x09) {
      throw new HttpProtocolError(
        'obs-fold not supported (RFC 9112 §5.2)',
        'OBS_FOLD',
        { rfc: 'RFC 9112 §5.2' },
      );
    }
    const idx = line.indexOf(':');
    if (idx < 0) {
      throw new HttpProtocolError(
        `header line missing colon: ${JSON.stringify(line)}`,
        'BAD_HEADERS',
        { rfc: 'RFC 9112 §5' },
      );
    }
    const name = line.slice(0, idx);
    if (!TCHAR.test(name)) {
      throw new HttpProtocolError(
        `invalid header name: ${JSON.stringify(name)}`,
        'BAD_HEADERS',
        { rfc: 'RFC 9110 §5.1' },
      );
    }
    const value = trimFieldValueOws(line.slice(idx + 1));
    validateFieldValueBytes(value, hex => new HttpProtocolError(
      `invalid control byte 0x${hex} in header value for ${JSON.stringify(name)}`,
      'BAD_HEADERS',
      { rfc: 'RFC 9110 §5.5' },
    ));
    const lower = name.toLowerCase();
    if (lower === 'content-length') rawContentLengths.push(value);
    else if (lower === 'transfer-encoding') rawTransferEncodings.push(value);
    respHeaders.append(name, value);
  }

  return { status, statusText, headers: respHeaders, rawContentLengths, rawTransferEncodings, remainder };
};

const finalizeResponse = (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  head: ResponseHead,
): RawHttpResponse => {
  const { status, statusText, headers, rawContentLengths, rawTransferEncodings, remainder } = head;

  // RFC 9112 §6.3: a message with both Transfer-Encoding and
  // Content-Length is an error (the sender is broken or actively
  // smuggling). Reject loud rather than picking one.
  if (rawTransferEncodings.length > 0 && rawContentLengths.length > 0) {
    throw new HttpProtocolError(
      'HTTP/1.1 response has both Transfer-Encoding and Content-Length',
      'CL_AND_TE',
      { rfc: 'RFC 9112 §6.3' },
    );
  }
  // RFC 9112 §6.3: multiple Content-Length values are an error unless
  // every value is the same single token. We forbid duplicates outright.
  if (rawContentLengths.length > 1) {
    throw new HttpProtocolError(
      `HTTP/1.1 response has ${rawContentLengths.length} Content-Length headers`,
      'MULTIPLE_CL',
      { rfc: 'RFC 9112 §6.3' },
    );
  }

  // Parse Transfer-Encoding as a token list; `chunked` MUST be the final
  // (or only) coding. Anything else (gzip, identity, etc.) framed without
  // chunked has no defined termination and we don't decode them anyway.
  const teTokens = rawTransferEncodings
    .flatMap(v => v.split(','))
    .map(t => t.trim().toLowerCase())
    .filter(t => t !== '');
  const teIsChunked = teTokens.length > 0 && teTokens[teTokens.length - 1] === 'chunked';
  if (teTokens.length > 0 && !teIsChunked) {
    throw new HttpProtocolError(
      `HTTP/1.1 response has Transfer-Encoding without chunked: ${teTokens.join(',')}`,
      'TE_NOT_CHUNKED',
      { rfc: 'RFC 9112 §6.1' },
    );
  }
  if (teTokens.filter(t => t === 'chunked').length > 1) {
    throw new HttpProtocolError(
      'HTTP/1.1 response has chunked listed more than once in Transfer-Encoding',
      'TE_DOUBLE_CHUNKED',
      { rfc: 'RFC 9112 §6.1' },
    );
  }
  const contentLength = rawContentLengths[0] ?? null;

  let body: ReadableStream<Uint8Array>;
  if (teIsChunked) {
    body = decodeChunked(reader, remainder);
    headers.delete('transfer-encoding');
  } else if (contentLength !== null) {
    const total = parseInt(contentLength, 10);
    if (!Number.isFinite(total) || total < 0 || String(total) !== contentLength) {
      throw new HttpProtocolError(
        `HTTP/1.1 response has malformed Content-Length: ${JSON.stringify(contentLength)}`,
        'BAD_CL',
        { rfc: 'RFC 9112 §6.2' },
      );
    }
    body = lengthBody(reader, remainder, total);
  } else {
    body = untilEofBody(reader, remainder);
  }

  return { status, statusText, headers, body };
};

// Body framing — Content-Length. Frames the body to exactly `total` bytes:
// surfaces TRAILING_BODY_BYTES if the transport delivers more (the next
// message of a keep-alive connection in our non-keep-alive world means the
// upstream is broken) and EOF if it delivers less.
const lengthBody = (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  head: Uint8Array,
  total: number,
): ReadableStream<Uint8Array> => {
  let consumed = 0;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      if (head.byteLength > total) {
        controller.error(new HttpProtocolError(
          `trailing bytes after Content-Length boundary (${head.byteLength - total} extra in head)`,
          'TRAILING_BODY_BYTES',
        ));
        try { await reader.cancel(); } catch { /* reader already cancelled */ }
        return;
      }
      if (head.byteLength) {
        controller.enqueue(head);
        consumed += head.byteLength;
      }
      if (consumed >= total) {
        controller.close();
        try { await reader.cancel(); } catch { /* reader already cancelled */ }
      }
    },
    async pull(controller) {
      // One transport read per pull — the stream's desiredSize is
      // re-evaluated between pulls, so a `while (consumed < total)` here
      // would drain the entire CL body into the controller queue at once
      // and bypass back-pressure (mirrors `untilEofBody` and the chunked
      // decoder's data branch). A 20 MiB JSON body under a slow consumer
      // would otherwise pin its full size in memory.
      const { value, done } = await reader.read();
      if (done) {
        controller.error(new HttpProtocolError(
          `upstream EOF after ${consumed}/${total} body bytes`,
          'EOF',
        ));
        return;
      }
      const remain = total - consumed;
      if (value.byteLength <= remain) {
        controller.enqueue(copy(value));
        consumed += value.byteLength;
      } else {
        controller.enqueue(copy(value.subarray(0, remain)));
        consumed += remain;
        controller.error(new HttpProtocolError(
          `trailing bytes after Content-Length boundary (${value.byteLength - remain} extra)`,
          'TRAILING_BODY_BYTES',
        ));
        try { await reader.cancel(); } catch { /* reader already cancelled */ }
        return;
      }
      if (consumed >= total) {
        controller.close();
        try { await reader.cancel(); } catch { /* reader already cancelled */ }
      }
    },
    cancel(reason) {
      reader.cancel(reason).catch(() => {});
    },
  });
};

const untilEofBody = (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  head: Uint8Array,
): ReadableStream<Uint8Array> => {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (head.byteLength) controller.enqueue(head);
    },
    async pull(controller) {
      const { value, done } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(copy(value));
    },
    cancel(reason) {
      reader.cancel(reason).catch(() => {});
    },
  });
};
