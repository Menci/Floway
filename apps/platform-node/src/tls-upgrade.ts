import net from 'node:net';
import { Duplex } from 'node:stream';
import tls from 'node:tls';

import { socketToReadable, socketToWritable } from './node-socket-streams.ts';
import type { DuplexStream } from '@floway-dev/http';
import { normalizeDialHost, throwAbort, type TlsUpgradeOptions } from '@floway-dev/platform';

// Idle time before the first keepalive probe, matching the raw dialer: a peer
// that disappears without a close-notify is otherwise held open by whoever
// is still reading, for as long as they keep waiting.
const KEEPALIVE_INITIAL_DELAY_MS = 60_000;

// Serialize the transport's Web-Streams duplex as a Node duplex so
// `tls.connect()` can wrap it. A TLSSocket is itself a Duplex, so an inner
// upgrade over an outer one — trojan's inner TLS over the visit to the proxy
// — is the same shape as an upgrade over a raw socket.
const transportToDuplex = (transport: DuplexStream): Duplex => {
  const duplex = Duplex.fromWeb({
    readable: transport.readable,
    writable: transport.writable,
  } as Parameters<typeof Duplex.fromWeb>[0]) as Duplex;
  // `tls.connect` re-emits what it observes on the socket, but nothing is
  // listening to a failed transport write. Hold it here so a rejected write
  // cannot land as an unhandled rejection; the handshake or the stream
  // consumer reports the failure.
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

// `signal` is honoured at three layers: (1) pre-upgrade short-circuit, (2)
// node:tls native abort during the handshake, (3) post-handshake
// socket.destroy() so subsequent reads and writes reject.
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

  socket.setKeepAlive(true, KEEPALIVE_INITIAL_DELAY_MS);

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

  if (signal) {
    const captured = signal;
    const onAbort = (): void => { socket.destroy(); };
    captured.addEventListener('abort', onAbort, { once: true });
    socket.once('close', () => { captured.removeEventListener('abort', onAbort); });
    // addEventListener on an already-aborted signal does not fire, so an
    // abort that landed between the entry check and this install would
    // otherwise be lost; drive it synchronously to close that window.
    if (captured.aborted) onAbort();
  }

  // Teardown needs no `close()` here: cancelling `readable` destroys the
  // TLS socket through its pipeline, and aborting `writable` destroys it
  // directly, so both halves already reach the transport.
  return { readable, writable };
};
