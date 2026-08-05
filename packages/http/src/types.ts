// Public types for HTTP/1.1 over a duplex byte stream.

/**
 * A duplex byte transport. Both halves are owned by the caller; the
 * primitives in this package borrow them through getReader/getWriter and
 * release the locks on every teardown path.
 */
export interface DuplexStream {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
}

/**
 * HTTP/1.1 request shape, transport-agnostic. The caller has already
 * dialed and (if needed) TLS-wrapped the stream — this package only
 * serializes the request and parses the response.
 *
 * `headers` MUST include `Host` (we do NOT synthesize one from the
 * transport; this package has no knowledge of the dial target).
 *
 * Caller-supplied `Content-Length`, `Transfer-Encoding`, and
 * `Connection` are stripped: the buffered body's exact length is the
 * source of truth, and this layer is one-shot per duplex (it always
 * emits `Connection: close`) so a `keep-alive` would mislead the server
 * into reusing a transport we plan to tear down.
 */
export interface HttpRequest {
  method: string;
  /** Path + query string, e.g. `/v1/messages?stream=true`. */
  path: string;
  headers: Record<string, string>;
  /** Optional buffered body. Streaming bodies are not supported. */
  body?: Uint8Array;
}

/**
 * Wire-faithful parse of an HTTP/1.1 response head + framed body. This is
 * the raw shape returned by `parseHttpResponse`. The Web `Response`
 * constructor refuses status codes outside 200..599 and refuses a non-null
 * body for 204/205/304 — all legal on the wire — so the parser hands back
 * this struct and lets the caller decide how to bridge to a Response (or
 * not). Use `toWebResponse` for the standard bridge.
 */
export interface RawHttpResponse {
  /** 3-digit HTTP status code, exactly as parsed from the status-line. */
  status: number;
  /**
   * The reason-phrase that followed the status code, with valid leading
   * SP/HTAB preserved and trailing whitespace removed. Empty when the
   * upstream sent an RFC 7230 erratum 4087 empty reason.
   */
  statusText: string;
  headers: Headers;
  body: ReadableStream<Uint8Array>;
}
