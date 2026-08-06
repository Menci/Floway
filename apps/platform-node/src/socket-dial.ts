import net from 'node:net';
import { PassThrough, pipeline, Readable } from 'node:stream';
import tls from 'node:tls';

import { normalizeDialHost, throwAbort, type DialedSocket, type SocketDial } from '@floway-dev/platform';

// Readable.toWeb(socket) waits for `finished(socket)`, which treats the
// net.Socket as both readable and writable. Projecting the read side through a
// PassThrough keeps Node's own backpressure, Buffer copying, error propagation,
// and cancellation teardown while letting peer FIN finish the read side
// independently. pipeline() observes the socket only as its readable source,
// so normal EOF does not close the socket's writable half. Node fixed the
// direct adapter upstream after our supported Node 22 line; this projection can
// disappear once our minimum runtime includes that fix.
// https://github.com/nodejs/node/blob/aa4c77582be995286fc6e00aaf530dc7ade102a9/lib/internal/webstreams/adapters.js#L424-L502
// https://github.com/nodejs/node/blob/783b3824831053fb020c17d456505ed76dfaef87/lib/internal/webstreams/adapters.js#L500-L527
// https://github.com/nodejs/node/blob/aa4c77582be995286fc6e00aaf530dc7ade102a9/lib/internal/streams/pipeline.js#L213-L267
const socketToReadable = (socket: net.Socket): ReadableStream<Uint8Array> => {
  const readable = new PassThrough({ highWaterMark: socket.readableHighWaterMark });
  pipeline(socket, readable, error => {
    // pipeline has already propagated the error into readable; keep the
    // callback as a final invariant guard for non-standard stream behavior.
    if (error && !readable.errored) readable.destroy(error);
  });
  return Readable.toWeb(readable) as ReadableStream<Uint8Array>;
};

// Hand-rolled adapter from a node:net.Socket to a WritableStream<Uint8Array>.
// Writable.toWeb only wires `close()` to socket.end(); writer.abort() is
// routed through the same end-of-stream path and leaves the underlying
// socket alive in a half-open state. Our proxy runners depend on
// cancellation actually destroying the socket so the inner-TLS stack
// stops trying to drain a dead leg, so we drive the four lifecycle hooks
// ourselves: write awaits the chunk callback (which fires once the chunk
// is flushed and naturally backpressures behind socket buffering), close
// half-closes the write side, abort destroys the socket, and a socket
// 'error' propagates into the writer via controller.error().
const socketToWritable = (socket: net.Socket): WritableStream<Uint8Array> => {
  let controller: WritableStreamDefaultController | null = null;
  const onError = (err: Error): void => { controller?.error(err); };
  socket.on('error', onError);
  socket.once('close', () => { socket.off('error', onError); });
  return new WritableStream<Uint8Array>({
    start(c) { controller = c; },
    write(chunk) {
      return new Promise<void>((resolve, reject) => {
        socket.write(chunk, err => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
    close() {
      return new Promise<void>(resolve => {
        socket.end(() => resolve());
      });
    },
    abort(reason) {
      // `destroy()` closes both halves immediately and surfaces the reason
      // on the next 'error' event. Wrap a non-Error reason in an Error so
      // destroy() carries something sensible into the runtime's logger.
      const err = reason instanceof Error ? reason : new Error(String(reason ?? 'aborted'));
      socket.destroy(err);
    },
  });
};

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
};
