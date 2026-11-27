// HTTP CONNECT proxy dialer.
//
// Native `socket.startTls()` is broken on Workers production edge after any
// pre-handshake bytes are exchanged (workerd #2712). We therefore:
//   1. Open a plain TCP socket to the proxy (or, if the proxy is HTTPS, ask
//      the runtime to wrap the proxy hop in TLS via the dial `tls` option).
//   2. Write CONNECT + auth, parse 2xx response.
//   3. Hand the post-CONNECT byte stream back as the dial result. This
//      avoids `startTls()` entirely.

import { concat, copy, findDoubleCrlfFrom, formatHostForUri } from '../bytes.ts';
import { ProxyDialError } from '../dial-error.ts';
import { assertValidTargetHost, assertValidTargetPort, connectOrDialError } from '../dial-target.ts';
import { base64EncodeBytes, utf8Bytes } from '../encoding.ts';
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

  const HEADER_BUFFER_CAP = 64 * 1024;
  const reader = socket.readable.getReader();
  let buf = new Uint8Array(0);
  let idx = -1;
  try {
    while (idx < 0) {
      // Include a terminator split across the last chunk boundary.
      const scanFrom = Math.max(0, buf.byteLength - 3);
      const { value, done } = await reader.read();
      if (done) throw new ProxyDialError(`CONNECT: EOF before status (${buf.byteLength} bytes read)`, 'proxy-handshake');
      buf = concat(buf, value);
      idx = findDoubleCrlfFrom(buf, scanFrom);
      if ((idx < 0 ? buf.byteLength : idx) > HEADER_BUFFER_CAP) {
        throw new ProxyDialError(`CONNECT response exceeded ${HEADER_BUFFER_CAP} bytes`, 'proxy-handshake');
      }
    }
    const head = new TextDecoder().decode(buf.subarray(0, idx));
    const statusLine = head.split('\r\n')[0]!;
    const match = STATUS_LINE.exec(statusLine);
    if (!match) throw new ProxyDialError(`CONNECT bad status line: ${JSON.stringify(statusLine)}`, 'proxy-handshake');
    const status = Number(match[1]);
    if (status < 200 || status >= 300) {
      throw new ProxyDialError(`CONNECT replied ${match[1]} ${match[2]!}`.trimEnd(), 'proxy-handshake');
    }
  } catch (cause) {
    reader.releaseLock();
    throw cause;
  }

  let trailing = buf.byteLength > idx + 4 ? copy(buf.subarray(idx + 4)) : undefined;
  let cancelled = false;
  const readable = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (trailing !== undefined) {
        controller.enqueue(trailing);
        trailing = undefined;
        return;
      }
      try {
        const item = await reader.read();
        if (cancelled) return;
        if (item.done) {
          reader.releaseLock();
          controller.close();
        } else {
          controller.enqueue(item.value);
        }
      } catch (cause) {
        if (cancelled) return;
        reader.releaseLock();
        controller.error(cause);
      }
    },
    async cancel(reason) {
      cancelled = true;
      try { await reader.cancel(reason); } finally {
        reader.releaseLock();
        await socket.close();
      }
    },
  }, { highWaterMark: 0 });

  return { readable, writable: socket.writable, close: () => socket.close() };
};
