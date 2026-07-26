// @floway-dev/http — HTTP/1.1, userspace TLS, and WebSocket framing over a
// duplex byte stream.
//
// This package speaks HTTP/1.1 against any duplex transport — a raw TCP
// socket, a userspace-TLS-wrapped stream, a CONNECT-tunnelled stream, etc.
// It has no opinion on how the duplex got there; the caller hands one in.
//
// It also ships a userspace TLS adapter for runtimes whose native
// `Socket.startTls()` cannot wrap a stream that has already exchanged
// plain bytes, and for protocols that need full control over TLS record
// framing.
//
// `wsUpgradeAndFrame` extends the same model to RFC 6455: take a duplex,
// negotiate the WebSocket Upgrade, return a frame-level duplex of
// unmasked binary payloads. Lets WebSocket-tunnelled protocols stay
// runtime-agnostic in the same way TCP+TLS protocols already are.
//
// We intend to extract and publish this package as an independent library,
// so its export surface is the whole protocol layer rather than the subset
// the rest of the workspace happens to call — a root export with no in-repo
// consumer is deliberate public API, not dead surface.

export type { DuplexStream, HttpRequest, RawHttpResponse } from './types.ts';

export { fetchOnStream } from './fetch-on-stream.ts';
export { parseHttpResponse, toWebResponse } from './parser.ts';
export { decodeChunked } from './chunked.ts';

export { userspaceTls, addTrustedRootCAs } from './tls.ts';
export type { UserspaceTlsOptions, TlsStream } from './tls.ts';

export { wsUpgradeAndFrame } from './ws-upgrade.ts';
export type { WsUpgradeOptions } from './ws-upgrade.ts';

export { signalAbortReason } from './abort.ts';

export { HttpProtocolError } from './errors.ts';
export type { HttpProtocolErrorCode } from './errors.ts';

export { STATUS_LINE } from './grammar.ts';
