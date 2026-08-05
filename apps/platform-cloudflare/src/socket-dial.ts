import { connect } from 'cloudflare:sockets';

import { normalizeDialHost, throwAbort, validateDialPort, type DialedSocket, type SocketDial } from '@floway-dev/platform';

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
  async connect(host, port, opts): Promise<DialedSocket> {
    if (opts?.signal?.aborted) throwAbort(opts.signal);
    const dialHost = normalizeDialHost(host);
    const dialPort = validateDialPort(port);
    const socket = connect(
      { hostname: dialHost, port: dialPort },
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
    let closePromise: Promise<void> | null = null;
    const safeClose = (): Promise<void> => {
      closePromise ??= socket.close().catch(() => { /* already closed/errored */ });
      return closePromise;
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
      void safeClose();
      // If the failure was caused by the caller's abort, surface as
      // AbortError (preserving the original reason if it was an Error)
      // instead of an opaque connect failure.
      if (opts?.signal?.aborted) throwAbort(opts.signal);
      throw new Error(`dial ${host}:${port} failed`, { cause });
    }

    if (opts?.signal?.aborted) {
      void safeClose();
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
