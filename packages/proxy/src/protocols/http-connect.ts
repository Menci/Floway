// HTTP CONNECT proxy dialer.
//
// Native `socket.startTls()` is broken on Workers production edge after any
// pre-handshake bytes are exchanged (workerd #2712). We therefore:
//   1. Open a plain TCP socket to the proxy (or, if the proxy is HTTPS, ask
//      the runtime to wrap the proxy hop in TLS via the dial `tls` option).
//   2. Write CONNECT + auth, parse 2xx response.
//   3. Hand the post-CONNECT byte stream back as the dial result. This
//      avoids `startTls()` entirely.

import { base64EncodeBytes, findDoubleCrlfFrom, formatHostForUri, utf8Bytes } from '../bytes.ts';
import { assertValidTargetHost, assertValidTargetPort, connectOrDialError } from '../dial-target.ts';
import { ProxyDialError } from '../errors.ts';
import { postHandshakeReadable } from '../post-handshake-readable.ts';
import type { HttpProxyConfig } from '../proxy-config.ts';
import type { DialOptions, DialResult, DialTarget, DialedSocket } from '../types.ts';
import { STATUS_LINE } from '@floway-dev/http';

export const dialHttpConnect = async (
  config: HttpProxyConfig,
  target: DialTarget,
  options: DialOptions,
): Promise<DialResult> => {
  assertValidTargetPort(target.port, 'CONNECT');
  assertValidTargetHost(target.host, 'CONNECT');

  const auth = config.username !== undefined
    ? { username: config.username, password: config.password ?? '' }
    : undefined;

  // workerd performs the outer TLS handshake inside connect() when tls=true,
  // so a TLS handshake error to the proxy surfaces as a connect failure here
  // — we can't tell the two apart from this layer.
  const socket = await connectOrDialError(options.socketDial, config.host, config.port, { tls: config.tls, signal: options.signal });

  try {
    return await dialHttpConnectInner(socket, auth, target);
  } catch (err) {
    // Any throw past `connect()` means the dial won't be returning a
    // stream — the response-body lifecycle that normally drives socket
    // teardown never starts. Close the socket explicitly so the resource
    // doesn't leak.
    void socket.close().catch(() => {});
    throw err;
  }
};

const dialHttpConnectInner = async (
  socket: DialedSocket,
  auth: { username: string; password: string } | undefined,
  target: DialTarget,
): Promise<DialResult> => {
  const writer = socket.writable.getWriter();
  const hostUriPart = formatHostForUri(target.host);
  const lines = [
    `CONNECT ${hostUriPart}:${target.port} HTTP/1.1`,
    `Host: ${hostUriPart}:${target.port}`,
    'Proxy-Connection: keep-alive',
  ];
  if (auth) {
    // RFC 7617 leaves the default credential charset undefined and allows a
    // server to advertise UTF-8. Floway consistently emits UTF-8 rather than
    // mapping JavaScript code units directly to bytes.
    // https://www.rfc-editor.org/rfc/rfc7617.html#section-2.1
    const token = base64EncodeBytes(utf8Bytes(`${auth.username}:${auth.password}`));
    lines.push(`Proxy-Authorization: Basic ${token}`);
  }
  try {
    await writer.write(utf8Bytes(`${lines.join('\r\n')}\r\n\r\n`));
  } finally {
    writer.releaseLock();
  }

  // Cap the CONNECT-response accumulation. A hostile or broken proxy that
  // streams data without ever emitting the double-CRLF would otherwise grow
  // the response until the host runtime's heap cap kills the request. 64 KiB is
  // two orders of magnitude over the real CONNECT-response size and still
  // bounds the worst case.
  const HEADER_BUFFER_CAP = 64 * 1024;
  const reader = socket.readable.getReader();
  try {
    let length = 0;
    let storage = new Uint8Array(1024);
    const bytes = (): Uint8Array => storage.subarray(0, length);
    const append = (chunk: Uint8Array): void => {
      const required = length + chunk.byteLength;
      if (required > storage.byteLength) {
        const next = new Uint8Array(Math.max(required, storage.byteLength * 2));
        next.set(storage.subarray(0, length));
        storage = next;
      }
      storage.set(chunk, length);
      length = required;
    };

    let idx = -1;
    while (idx < 0) {
      const scanFrom = Math.max(0, length - 3);
      const { value, done } = await reader.read();
      if (done) throw new ProxyDialError(`CONNECT: EOF before status (${length} bytes read)`, 'proxy-handshake');
      append(value);
      idx = findDoubleCrlfFrom(bytes(), scanFrom);
      if (idx < 0 && length > HEADER_BUFFER_CAP) {
        throw new ProxyDialError(`CONNECT response exceeded ${HEADER_BUFFER_CAP} bytes without a header terminator`, 'proxy-handshake');
      }
    }
    if (idx > HEADER_BUFFER_CAP) {
      throw new ProxyDialError(`CONNECT response exceeded ${HEADER_BUFFER_CAP} bytes before its header terminator`, 'proxy-handshake');
    }

    const buffer = bytes();
    const head = new TextDecoder().decode(buffer.subarray(0, idx));
    const statusLine = head.split('\r\n')[0]!;
    const m = STATUS_LINE.exec(statusLine);
    if (!m) throw new ProxyDialError(`CONNECT bad status line: ${JSON.stringify(statusLine)}`, 'proxy-handshake');
    const status = parseInt(m[1]!, 10);
    if (status < 200 || status >= 300) {
      throw new ProxyDialError(`CONNECT replied ${m[1]} ${m[2]!}`.trimEnd(), 'proxy-handshake');
    }

    return {
      readable: postHandshakeReadable(socket, reader, buffer.subarray(idx + 4)),
      writable: socket.writable,
    };
  } catch (error) {
    try { reader.releaseLock(); } catch { /* lock already released */ }
    throw error;
  }
};
