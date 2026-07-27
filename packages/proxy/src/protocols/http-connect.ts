// HTTP CONNECT proxy dialer.
//
// Native `socket.startTls()` is broken on Workers production edge after any
// pre-handshake bytes are exchanged (workerd #2712). We therefore:
//   1. Open a plain TCP socket to the proxy (or, if the proxy is HTTPS, ask
//      the runtime to wrap the proxy hop in TLS via the dial `tls` option).
//   2. Write CONNECT + auth, parse 2xx response.
//   3. Hand the post-CONNECT byte stream back as the dial result. This
//      avoids `startTls()` entirely.

import { base64EncodeBytes, concat, copy, findDoubleCrlfFrom, formatHostForUri, utf8Bytes } from '../bytes.ts';
import { assertValidTargetHost, assertValidTargetPort, connectOrDialError } from '../dial-target.ts';
import { ProxyDialError } from '../errors.ts';
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
    // RFC 7617 §2.1 defaults the credential charset to UTF-8. `btoa` on a
    // JS string Latin-1-encodes each code unit, so a password byte in
    // U+0080..U+00FF would go on the wire as that single Latin-1 byte
    // and a code point > U+00FF would throw InvalidCharacterError mid-
    // dial. Encode to UTF-8 bytes first, then base64.
    const token = base64EncodeBytes(utf8Bytes(`${auth.username}:${auth.password}`));
    lines.push(`Proxy-Authorization: Basic ${token}`);
  }
  await writer.write(utf8Bytes(`${lines.join('\r\n')}\r\n\r\n`));
  writer.releaseLock();

  const { readable: postConnect, writable: forward } = new TransformStream<Uint8Array, Uint8Array>();
  const fwdWriter = forward.getWriter();

  // Cap the CONNECT-response accumulation. A hostile or broken proxy that
  // streams data without ever emitting the double-CRLF would otherwise grow
  // `buf` until the host runtime's heap cap kills the request. 64 KiB is
  // two orders of magnitude over the real CONNECT-response size and still
  // bounds the worst case.
  const HEADER_BUFFER_CAP = 64 * 1024;
  const reader = socket.readable.getReader();
  const peelDone = (async () => {
    try {
      let buf = new Uint8Array(0);
      let idx = findDoubleCrlfFrom(buf, 0);
      while (idx < 0) {
        // Resume from the last position where a partial terminator could have
        // started straddling the seam — three bytes back covers `CR LF CR ?`
        // landing across the read boundary. Without this resume index the
        // per-read scan is O(n) on the whole buffer, turning a 1-byte drip
        // up to HEADER_BUFFER_CAP into O(n²).
        const scanFrom = Math.max(0, buf.byteLength - 3);
        const { value, done } = await reader.read();
        if (done) throw new ProxyDialError(`CONNECT: EOF before status (${buf.byteLength} bytes read)`, 'proxy-handshake');
        buf = concat(buf, value);
        idx = findDoubleCrlfFrom(buf, scanFrom);
        if (idx < 0 && buf.byteLength > HEADER_BUFFER_CAP) {
          throw new ProxyDialError(`CONNECT response exceeded ${HEADER_BUFFER_CAP} bytes without a header terminator`, 'proxy-handshake');
        }
      }
      const head = new TextDecoder().decode(buf.subarray(0, idx));
      const statusLine = head.split('\r\n')[0]!;
      const m = STATUS_LINE.exec(statusLine);
      if (!m) throw new ProxyDialError(`CONNECT bad status line: ${JSON.stringify(statusLine)}`, 'proxy-handshake');
      const status = parseInt(m[1]!, 10);
      if (status < 200 || status >= 300) {
        throw new ProxyDialError(`CONNECT replied ${m[1]} ${m[2]!}`.trimEnd(), 'proxy-handshake');
      }
      const trailing = buf.subarray(idx + 4);
      if (trailing.byteLength) await fwdWriter.write(copy(trailing));
      while (true) {
        const r = await reader.read();
        if (r.done) {
          try { await fwdWriter.close(); } catch { /* fwd already closed */ }
          return;
        }
        await fwdWriter.write(copy(r.value));
      }
    } finally {
      try { reader.releaseLock(); } catch { /* lock already released */ }
    }
  })();
  // Always-on terminal handler routes peel errors into the forward stream
  // so the next consumer sees them as transport failures rather than an
  // unhandled rejection. The outer dial-time try/catch has already exited
  // by the time this fires, so we ALSO close the socket here — once we
  // return, the caller only holds wrapper streams and has no way to reach
  // the raw socket.
  peelDone.catch(e => {
    fwdWriter.abort(e).catch(() => {});
    void socket.close().catch(() => {});
  });

  return { readable: postConnect, writable: socket.writable };
};
