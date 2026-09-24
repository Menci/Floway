import { connect } from 'cloudflare:sockets';

import { normalizeDialHost, throwAbort, type DialedSocket, type SocketDial } from '@floway-dev/platform';

// workerd reports every non-2xx outbound CONNECT proxy status with this same
// message; it covers Cloudflare IPs as well as other disallowed destinations.
// Tag it only when socket.opened rejects, before any request bytes are sent.
// https://github.com/cloudflare/workerd/blob/c889d1dd2322420cb5c58740dc28ab20b6a7f681/src/workerd/api/sockets.c%2B%2B#L969-L1017
const PROXY_CONNECT_REJECTION = 'proxy request failed, cannot connect to the specified address';

class ProxyConnectRejection extends Error {}

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
    const removeAbortListener = (): void => {
      if (abortListener && opts?.signal) {
        opts.signal.removeEventListener('abort', abortListener);
        abortListener = null;
      }
    };
    if (opts?.signal) {
      const signal = opts.signal;
      abortListener = (): void => { void safeClose(); };
      signal.addEventListener('abort', abortListener, { once: true });
    }
    // Explicit catch so an unhandled-rejection observer doesn't see
    // socket.closed rejecting on connect failure.
    void socket.closed.catch(() => { /* errors observed via opened/streams */ }).finally(removeAbortListener);

    try {
      await socket.opened;
    } catch (cause) {
      removeAbortListener();
      await safeClose();
      // If the failure was caused by the caller's abort, surface as
      // AbortError (preserving the original reason if it was an Error)
      // instead of an opaque connect failure.
      if (opts?.signal?.aborted) throwAbort(opts.signal);
      const ConnectError = cause instanceof Error && cause.message.startsWith(PROXY_CONNECT_REJECTION)
        ? ProxyConnectRejection
        : Error;
      throw new ConnectError(`dial ${host}:${port} failed`, { cause });
    }

    if (opts?.signal?.aborted) {
      await safeClose();
      throwAbort(opts.signal);
    }

    return {
      readable: socket.readable,
      writable: socket.writable,
      close: async () => {
        removeAbortListener();
        await safeClose();
      },
    };
  },
};
