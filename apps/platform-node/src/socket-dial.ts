import net from 'node:net';
import tls from 'node:tls';

import { socketToReadable, socketToWritable } from './node-socket-streams.ts';
import { startNodeTls } from './tls-upgrade.ts';
import { normalizeDialHost, throwAbort, type DialedSocket, type SocketDial } from '@floway-dev/platform';

// Idle time before the first keepalive probe. Node then follows the OS
// settings for probe interval and count, so a dead peer is reaped within a
// few minutes of going silent without us restating the platform's tuning.
const KEEPALIVE_INITIAL_DELAY_MS = 60_000;

// `signal` is honoured at three layers: (1) pre-connect short-circuit, (2)
// node:net / node:tls native abort during the connect handshake, (3) post-
// connect socket.destroy() so subsequent reads/writes reject.
export const nodeSocketDial: SocketDial = {
  async connect(host, port, opts): Promise<DialedSocket> {
    if (opts?.signal?.aborted) throwAbort(opts.signal);
    const dialHost = normalizeDialHost(host);
    // node:net / node:tls accept `signal` natively; passing it lets the
    // runtime tear down a connect that has not yet fired 'connect' /
    // 'secureConnect' without us having to race anything ourselves.
    // We don't request `allowHalfOpen` on TLS — close-notify makes
    // half-close fragile across TLS 1.3 implementations.
    //
    // tls.connect honours `signal` at runtime but @types/node hasn't yet
    // surfaced it on tls.ConnectionOptions; @ts-expect-error makes the
    // type lag visible (the line will start failing the day the type is
    // added) so we can drop the suppression instead of letting an `as`
    // cast silently absorb future shape changes.
    const signal = opts?.signal;
    const socket = opts?.tls
      // @ts-expect-error – see block comment above
      ? tls.connect({ host: dialHost, port, servername: dialHost, signal })
      : net.connect({ host: dialHost, port, allowHalfOpen: true, signal });
    const readyEvent = opts?.tls ? 'secureConnect' : 'connect';
    await new Promise<void>((resolve, reject) => {
      const onReady = (): void => {
        socket.off('error', onError);
        resolve();
      };
      const onError = (err: Error): void => {
        socket.off(readyEvent, onReady);
        reject(err);
      };
      socket.once(readyEvent, onReady);
      socket.once('error', onError);
    });

    // A dialed socket is otherwise torn down only by the response body's own
    // read-to-end or cancel path, so a peer that disappears without sending
    // FIN — a dropped NAT/conntrack entry, a killed daemon — leaves the socket
    // and everything the read pipeline holds behind it alive indefinitely.
    // TCP keepalive is the teardown that does not depend on anyone reading:
    // probes only fire once the connection is idle at the TCP layer, so a live
    // upstream that is merely slow (a long prompt-processing pause before the
    // first token) answers them and is never disturbed.
    socket.setKeepAlive(true, KEEPALIVE_INITIAL_DELAY_MS);

    const readable = socketToReadable(socket);
    const writable = socketToWritable(socket);

    // Listen on 'close' rather than the toWeb readable's own close signal:
    // the latter fires on read-side EOF and would resolve early whenever the
    // peer half-closes its write side.
    const closed = new Promise<void>(resolve => {
      socket.once('close', () => resolve());
    });

    // After the connect handshake resolves, the dial-time onError listener is
    // gone. Without a permanent 'error' listener Node escalates any
    // post-connect socket error to uncaughtException and crashes the process.
    // The error itself surfaces via the readable/writable streams the proxy
    // runners drive — this listener keeps Node from crashing post-connect;
    // the debug branch below makes those errors observable when
    // FLOWAY_DEBUG_SOCKET is set.
    socket.on('error', err => {
      if (process.env.FLOWAY_DEBUG_SOCKET) {
        console.debug('[socket-dial] post-connect error:', err);
      }
    });

    if (opts?.signal) {
      const captured = opts.signal;
      const onAbort = (): void => { socket.destroy(); };
      captured.addEventListener('abort', onAbort, { once: true });
      // Drop the listener on natural socket close so a long-lived caller
      // signal (e.g. a request controller shared across dials) doesn't
      // accumulate one closure per dial pinning the destroyed socket.
      socket.once('close', () => {
        captured.removeEventListener('abort', onAbort);
      });
      // Node's native `signal` for net.connect / tls.connect only honours
      // aborts during the connect phase; once 'connect' / 'secureConnect'
      // has fired, post-connect aborts are entirely up to the listener
      // installed above. addEventListener('abort') on an already-aborted
      // signal does not fire, so an abort that landed between the
      // entry-point pre-check and this listener install would otherwise
      // be lost. Drive onAbort synchronously to close that TOCTOU window.
      if (captured.aborted) onAbort();
    }

    return {
      readable,
      writable,
      close: async () => {
        socket.destroy();
        await closed;
      },
    };
  },

  // The raw dialer can already run TLS, but only when the socket is opened
  // for it. Everything that finishes a plaintext handshake first — HTTP
  // CONNECT, SOCKS5, the upstream leg of every proxy — needs the upgrade
  // here, and Node's own `tls.connect` is the runtime's TLS implementation.
  startTls: startNodeTls,
};
