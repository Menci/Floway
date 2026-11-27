import net from 'node:net';
import tls from 'node:tls';

import { isNodeConnectFailure } from './network-failure.ts';
import { bindSocketAbort, socketFailure, socketToReadable, socketToWritable } from './node-socket-streams.ts';
import { startNodeTls } from './tls-upgrade.ts';
import { normalizeDialHost, throwAbort, type DialedSocket, type SocketDial } from '@floway-dev/platform';

// Idle time before the first keepalive probe. Node then follows the OS
// settings for probe interval and count, so a dead peer is reaped within a
// few minutes of going silent without us restating the platform's tuning.
const KEEPALIVE_INITIAL_DELAY_MS = 60_000;

export const nodeSocketDial: SocketDial = {
  async connect(host, port, opts): Promise<DialedSocket> {
    if (opts?.signal?.aborted) throwAbort(opts.signal);
    const dialHost = normalizeDialHost(host);
    // We don't request `allowHalfOpen` on TLS — close-notify makes
    // half-close fragile across TLS 1.3 implementations.
    const signal = opts?.signal;
    const socket = opts?.tls
      ? tls.connect({ host: dialHost, port, servername: dialHost })
      : net.connect({ host: dialHost, port, allowHalfOpen: true });
    const readyEvent = opts?.tls ? 'secureConnect' : 'connect';
    await new Promise<void>((resolve, reject) => {
      const onReady = (): void => {
        socket.off('error', onError);
        resolve();
      };
      const onError = (err: Error): void => {
        socket.off(readyEvent, onReady);
        reject(socketFailure(err, signal, isNodeConnectFailure));
      };
      socket.once(readyEvent, onReady);
      socket.once('error', onError);
      bindSocketAbort(socket, signal);
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

    const identify = (cause: unknown) => socketFailure(cause, signal, isNodeConnectFailure);
    const readable = socketToReadable(socket, identify);
    const writable = socketToWritable(socket, identify);

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
