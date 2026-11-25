import { connect } from 'cloudflare:sockets';

import { isCloudflareNetworkFailure } from './network-failure.ts';
import { cloudflareSocketReadable } from './socket-readable.ts';
import { isCausedBy, markTransportFailure, signalAbortReason, UpstreamTransportError, userspaceTls } from '@floway-dev/http';
import { normalizeDialHost, throwAbort, type DialedSocket, type SocketDial } from '@floway-dev/platform';

// workerd reports every non-2xx outbound CONNECT proxy status with this same
// message; it covers Cloudflare IPs as well as other disallowed destinations.
// Tag it only when socket.opened rejects, before any request bytes are sent.
// https://github.com/cloudflare/workerd/blob/c889d1dd2322420cb5c58740dc28ab20b6a7f681/src/workerd/api/sockets.c%2B%2B#L969-L1017
const PROXY_CONNECT_REJECTION = 'proxy request failed, cannot connect to the specified address';

class ProxyConnectRejection extends UpstreamTransportError {}

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
    let abortListener: (() => void) | null = null;
    const read = cloudflareSocketReadable(socket.readable);
    let closePromise: Promise<void> | undefined;
    let openingCancellation: Error | undefined;
    const opening = Promise.withResolvers<void>();
    void socket.opened.then(() => opening.resolve(), opening.reject);
    const removeAbortListener = (): void => {
      if (abortListener && opts?.signal) {
        opts.signal.removeEventListener('abort', abortListener);
        abortListener = null;
      }
    };
    const close = (reason?: Error): Promise<void> => {
      removeAbortListener();
      closePromise ??= (async () => {
        try {
          if (reason !== undefined) await read.abortPendingRead(reason);
        } finally {
          await safeClose();
        }
      })();
      return closePromise;
    };
    if (opts?.signal) {
      const signal = opts.signal;
      abortListener = (): void => {
        const reason = signalAbortReason(signal);
        openingCancellation = reason;
        queueMicrotask(() => { opening.reject(reason); });
        void close(reason).catch(error => console.error('Cloudflare socket cancellation failed', error));
      };
      signal.addEventListener('abort', abortListener, { once: true });
    }
    // Explicit catch so an unhandled-rejection observer doesn't see
    // socket.closed rejecting on connect failure.
    void socket.closed.catch(() => { /* errors observed via opened/streams */ }).finally(removeAbortListener);

    try {
      await opening.promise;
    } catch (cause) {
      await close();
      if (isCausedBy(cause, openingCancellation)) throw cause;
      const message = `dial ${host}:${port} failed`;
      if (cause instanceof Error && cause.message.startsWith(PROXY_CONNECT_REJECTION)) throw new ProxyConnectRejection(cause, message);
      if (isCloudflareNetworkFailure(cause)) throw new UpstreamTransportError(cause, message);
      throw cause;
    }

    if (opts?.signal?.aborted) {
      await close();
      throwAbort(opts.signal);
    }

    return {
      readable: read.readable,
      writable: socketWritable(socket.writable, opts?.signal),
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

const socketWritable = (source: WritableStream<Uint8Array>, signal?: AbortSignal): WritableStream<Uint8Array> => {
  let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  const getWriter = () => writer ??= source.getWriter();
  const finish = async (action: (writer: WritableStreamDefaultWriter<Uint8Array>) => Promise<void>): Promise<void> => {
    const active = getWriter();
    try { await action(active); } finally { active.releaseLock(); }
  };
  return new WritableStream({
    write(chunk) {
      const active = getWriter();
      const pending = active.write(chunk);
      return pending.catch((cause: unknown) => {
        active.releaseLock();
        throw isCloudflareNetworkFailure(cause) ? markTransportFailure(cause, signal) : cause;
      });
    },
    close: () => finish(active => active.close()),
    abort: reason => finish(active => active.abort(reason)),
  });
};
