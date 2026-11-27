import { connect } from 'cloudflare:sockets';

import { isCloudflareNetworkFailure } from './network-failure.ts';
import { cloudflareSocketReadable, cloudflareSocketWritable } from './socket-streams.ts';
import { HttpTransportError, isCausedBy, signalAbortReason, userspaceTls } from '@floway-dev/http';
import { normalizeDialHost, throwAbort, type DialedSocket, type SocketDial } from '@floway-dev/platform';

// workerd reports every non-2xx outbound CONNECT proxy status with this same
// message; it covers Cloudflare IPs as well as other disallowed destinations.
// Tag it only when socket.opened rejects, before any request bytes are sent.
// https://github.com/cloudflare/workerd/blob/c889d1dd2322420cb5c58740dc28ab20b6a7f681/src/workerd/api/sockets.c%2B%2B#L969-L1017
const PROXY_CONNECT_REJECTION = 'proxy request failed, cannot connect to the specified address';

class ProxyConnectRejection extends HttpTransportError {
  constructor(host: string, port: number, cause: Error) {
    super(cause);
    this.message = `dial ${host}:${port} failed: ${cause.message}`;
  }
}

// AbortSignal handling: cloudflare:sockets doesn't accept a signal on connect
// itself, so we honour it ourselves. A pre-aborted signal short-circuits
// before opening a socket; once opened, an abort closes the socket so
// subsequent reads/writes reject. The listener is detached on close() and on
// natural socket close so a long-lived caller signal doesn't accumulate one
// pinned closure per dial.
//
// We `await socket.opened` before resolving so a TLS handshake error or
// connect-refused surfaces as a connect-time rejection (with `cause`)
// rather than as an opaque first-read failure later.

export const cloudflareSocketDial: SocketDial = {
  shouldConnectErrorFallbackToFetch: error => error instanceof ProxyConnectRejection,
  async connect(host, port, opts): Promise<DialedSocket> {
    if (opts?.signal?.aborted) throwAbort(opts.signal);
    const dialHost = normalizeDialHost(host);
    const socket = connect(
      { hostname: dialHost, port },
      {
        // Half-open is honoured for plain TCP only. On the TLS leg, close-notify
        // makes half-close fragile across TLS 1.3 implementations, so we mirror
        // Node's deliberate no-half-open-on-TLS choice — write-side close from
        // the consumer tears down the whole socket.
        allowHalfOpen: !opts?.tls,
        secureTransport: opts?.tls ? 'on' : 'off',
      },
    );
    // Idempotent close — the runtime can reject `socket.close()` on an already
    // errored socket, and a stalled close promise must not block teardown.
    const safeClose = async (): Promise<void> => {
      try { await socket.close(); } catch { /* already closed/errored */ }
    };
    const signal = opts?.signal;
    const opening = Promise.withResolvers<void>();
    void socket.opened.then(() => opening.resolve(), opening.reject);
    const read = cloudflareSocketReadable(socket.readable);
    const write = cloudflareSocketWritable(socket.writable);
    let closePromise: Promise<void> | undefined;
    let abortRead: Promise<void> | undefined;
    const close = (): Promise<void> => closePromise ??= Promise.all([safeClose(), abortRead])
      .then(() => undefined).finally(removeAbortListener);
    const removeAbortListener = (): void => signal?.removeEventListener('abort', abortListener);
    const abortListener = (): void => {
      const reason = signalAbortReason(signal!);
      // Native results already settled in this turn keep their original cause.
      queueMicrotask(() => {
        opening.reject(reason);
        abortRead = read.abort(reason).catch(() => { /* the socket may already have closed */ });
        write.abort(reason);
        void close();
      });
    };
    signal?.addEventListener('abort', abortListener, { once: true });
    // Explicit catch so an unhandled-rejection observer doesn't see
    // socket.closed rejecting on connect failure.
    void socket.closed.catch(() => { /* errors observed via opened/streams */ }).finally(removeAbortListener);

    try {
      await opening.promise;
    } catch (cause) {
      await close();
      if (isCausedBy(cause, signal?.reason)) throw cause;
      if (cause instanceof Error && cause.message.startsWith(PROXY_CONNECT_REJECTION)) throw new ProxyConnectRejection(host, port, cause);
      if (isCloudflareNetworkFailure(cause)) throw new HttpTransportError(cause);
      throw cause;
    }

    if (signal?.aborted) {
      await close();
      throwAbort(signal);
    }

    return {
      readable: read.readable,
      writable: write.writable,
      close,
    };
  },

  // Upgrades land on sockets this dialer opened with `secureTransport` 'on'
  // or 'off', and workerd's `startTls()` requires 'starttls' at connect time;
  // where a plaintext handshake already ran, it also fails once bytes have
  // been exchanged (issue #2712). So every upgrade runs in userspace, and the
  // `secureTransport: 'on'` branch above is the only place TLS is left to
  // workerd.
  // https://github.com/cloudflare/workerd/issues/2712
  startTls: userspaceTls,
};
