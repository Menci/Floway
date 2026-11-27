import net from 'node:net';
import { Duplex } from 'node:stream';
import tls from 'node:tls';

import { isNodeConnectFailure } from './network-failure.ts';
import { bindSocketAbort, socketFailure, socketToReadable, socketToWritable } from './node-socket-streams.ts';
import { isCausedBy, trackReadableFailure, type DuplexStream } from '@floway-dev/http';
import { normalizeDialHost, throwAbort, type TlsUpgradeOptions } from '@floway-dev/platform';

// Serialize the transport's Web-Streams duplex as a Node duplex so
// `tls.connect()` can wrap it. A TLSSocket is itself a Duplex, so an inner
// upgrade over an outer one — trojan's inner TLS over the visit to the proxy
// — is the same shape as an upgrade over a raw socket.
const transportToDuplex = (transport: DuplexStream) => {
  const input = trackReadableFailure(transport.readable);
  const writer = transport.writable.getWriter();
  let writeFailure: { cause: unknown } | undefined;
  const finish = async (operation: Promise<void>) => {
    try { await operation; } finally { writer.releaseLock(); }
  };
  const output = new WritableStream<Uint8Array>({
    async write(chunk) {
      try {
        await writer.write(chunk);
      } catch (cause) {
        writeFailure = { cause };
        writer.releaseLock();
        throw cause;
      }
    },
    close: () => finish(writer.close()),
    abort: reason => finish(writer.abort(reason)),
  });
  const duplex = Duplex.fromWeb({
    readable: input.body,
    writable: output,
  } as Parameters<typeof Duplex.fromWeb>[0]);
  // A rejected transport write surfaces as an 'error' event on this duplex
  // with no listener of its own, which terminates the process: `Duplex.fromWeb`
  // turns the failed web-stream write into an event, and before `tls.connect`
  // wraps the stream nothing re-emits it. Hold it here so the handshake or the
  // stream consumer reports the failure instead.
  duplex.on('error', () => { /* reported by the TLS socket or its consumer */ });
  const isForwardedFailure = (cause: unknown) => isCausedBy(cause, input.failure?.cause) || isCausedBy(cause, writeFailure?.cause);
  return { duplex, isForwardedFailure };
};

// Node verifies the peer against `servername` when it is set and against
// `host` otherwise, so a caller that separates the SNI name from the reference
// identity has to install the check itself.
const makeIdentityCheck = (identity: string) =>
  (_servername: string, peer: tls.PeerCertificate): Error | undefined =>
    tls.checkServerIdentity(identity, peer);

export const startNodeTls = async (
  transport: DuplexStream,
  opts: TlsUpgradeOptions,
): Promise<DuplexStream> => {
  if (opts.signal?.aborted) throwAbort(opts.signal);
  const servername = normalizeDialHost(opts.host);
  const identity = normalizeDialHost(opts.verifyHost ?? opts.host);
  const signal = opts.signal;

  const { duplex, isForwardedFailure } = transportToDuplex(transport);
  const identify = (cause: unknown) => isForwardedFailure(cause) ? cause : socketFailure(cause, signal, isNodeConnectFailure);

  // Bytes that have to precede the ClientHello — a proxy request header the
  // peer reads before it starts relaying TLS — go out first, so the handshake
  // flight queues behind them instead of racing them.
  if (opts.prefix !== undefined && opts.prefix.byteLength > 0) {
    const prefix = opts.prefix;
    bindSocketAbort(duplex, signal);
    await new Promise<void>((resolve, reject) => {
      duplex.write(prefix, error => (error ? reject(duplex.errored ?? error) : resolve()));
    });
  }

  let socket: tls.TLSSocket;
  try {
    if (signal?.aborted) throwAbort(signal);
    socket = tls.connect({
      socket: duplex,
      // `host` doubles as the default identity; an IP literal never goes
      // into `server_name` (RFC 6066 §3).
      host: identity,
      ...(net.isIP(servername) === 0 ? { servername } : {}),
      ALPNProtocols: opts.alpn,
      rejectUnauthorized: !opts.insecure,
      ...(opts.insecure ? {} : { checkServerIdentity: makeIdentityCheck(identity) }),
    });
  } catch (cause) {
    duplex.destroy();
    throw cause;
  }

  await new Promise<void>((resolve, reject) => {
    const onReady = (): void => {
      socket.off('error', onError);
      resolve();
    };
    const onError = (err: Error): void => {
      socket.off('secureConnect', onReady);
      reject(identify(err));
    };
    socket.once('secureConnect', onReady);
    socket.once('error', onError);
    bindSocketAbort(socket, signal);
  });

  const readable = socketToReadable(socket, identify);
  const writable = socketToWritable(socket, identify);

  // Without a permanent listener, any post-handshake socket error escalates
  // to uncaughtException and crashes the process. The streams carry the error
  // to the consumer — this listener keeps the process alive to do so.
  socket.on('error', err => {
    if (process.env.FLOWAY_DEBUG_SOCKET) {
      console.debug('[tls-upgrade] post-handshake error:', err);
    }
  });

  // Teardown needs no `close()` here: cancelling `readable` destroys the
  // TLS socket through its pipeline, and aborting `writable` destroys it
  // directly, so both halves already reach the transport.
  return { readable, writable };
};
