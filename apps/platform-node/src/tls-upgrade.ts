import net from 'node:net';
import { Duplex } from 'node:stream';
import tls from 'node:tls';

import { socketToReadable, socketToWritable } from './node-socket-streams.ts';
import type { DuplexStream } from '@floway-dev/http';
import { normalizeDialHost, throwAbort, type TlsUpgradeOptions } from '@floway-dev/platform';

// Serialize the transport's Web-Streams duplex as a Node duplex so
// `tls.connect()` can wrap it. A TLSSocket is itself a Duplex, so an inner
// upgrade over an outer one — trojan's inner TLS over the visit to the proxy
// — is the same shape as an upgrade over a raw socket.
const transportToDuplex = (transport: DuplexStream): Duplex => {
  const duplex = Duplex.fromWeb({
    readable: transport.readable,
    writable: transport.writable,
  } as Parameters<typeof Duplex.fromWeb>[0]);
  // A rejected transport write surfaces as an 'error' event on this duplex
  // with no listener of its own, which terminates the process: `Duplex.fromWeb`
  // turns the failed web-stream write into an event, and before `tls.connect`
  // wraps the stream nothing re-emits it. Hold it here so the handshake or the
  // stream consumer reports the failure instead.
  duplex.on('error', () => { /* reported by the TLS socket or its consumer */ });
  return duplex;
};

// Node verifies the peer against `servername` when it is set and against
// `host` otherwise, so a caller that separates the SNI name from the reference
// identity, or that supplies its own check, has to install one here. Node's
// `checkServerIdentity` is the default; a caller-provided callback replaces it
// with the same `(identity, certificate) => Error | undefined` contract.
const makeIdentityCheck = (
  identity: string,
  check: TlsUpgradeOptions['checkServerIdentity'],
) => (_servername: string, peer: tls.PeerCertificate): Error | undefined =>
  check === undefined ? tls.checkServerIdentity(identity, peer) : check(identity, peer);

// `signal` is honoured at two layers: a pre-upgrade short-circuit, and the
// abort wiring `tls.connect` installs on the socket for its whole lifetime —
// handshake and streaming alike.
export const startNodeTls = async (
  transport: DuplexStream,
  opts: TlsUpgradeOptions,
): Promise<DuplexStream> => {
  if (opts.signal?.aborted) throwAbort(opts.signal);
  const servername = normalizeDialHost(opts.host);
  const identity = normalizeDialHost(opts.verifyHost ?? opts.host);
  const signal = opts.signal;

  const duplex = transportToDuplex(transport);

  // Bytes that have to precede the ClientHello — a proxy request header the
  // peer reads before it starts relaying TLS — go out first, so the handshake
  // flight queues behind them instead of racing them.
  if (opts.prefix !== undefined && opts.prefix.byteLength > 0) {
    const prefix = opts.prefix;
    await new Promise<void>((resolve, reject) => {
      duplex.write(prefix, error => (error ? reject(error) : resolve()));
    });
  }

  // `tls.connect` honours `signal` at runtime, but @types/node has not
  // surfaced it on ConnectionOptions. @ts-expect-error keeps the type lag
  // visible — the line starts failing the day the type lands, which is the
  // signal to drop the suppression rather than let a cast absorb it.
  // @ts-expect-error – see comment above
  const socket = tls.connect({
    socket: duplex,
    // `host` doubles as the default identity, so it has to be the reference
    // identity; an IP literal never goes into `server_name` (RFC 6066 §3).
    host: identity,
    ...(net.isIP(servername) === 0 ? { servername } : {}),
    ALPNProtocols: opts.alpn,
    rejectUnauthorized: !opts.insecure,
    ...(opts.insecure ? {} : { checkServerIdentity: makeIdentityCheck(identity, opts.checkServerIdentity) }),
    signal,
  });

  await new Promise<void>((resolve, reject) => {
    const onReady = (): void => {
      socket.off('error', onError);
      resolve();
    };
    const onError = (err: Error): void => {
      socket.off('secureConnect', onReady);
      reject(err);
    };
    socket.once('secureConnect', onReady);
    socket.once('error', onError);
  });

  const readable = socketToReadable(socket);
  const writable = socketToWritable(socket);

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
