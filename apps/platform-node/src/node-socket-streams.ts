import type net from 'node:net';
import { PassThrough, pipeline, Readable } from 'node:stream';

// Shared projection of a Node duplex socket (net.Socket or tls.TLSSocket)
// onto the Web Streams duplex the rest of the workspace consumes. Both the
// raw dialer and the native TLS upgrader need the same teardown and
// backpressure semantics, so they share this adapter.

// Readable.toWeb(socket) waits for `finished(socket)`, which treats the
// socket as both readable and writable. Projecting the read side through a
// PassThrough keeps Node's own backpressure, Buffer copying, error
// propagation, and cancellation teardown while letting peer FIN finish the
// read side independently. pipeline() observes the socket only as its
// readable source, so normal EOF does not close the socket's writable half.
// Node fixed the direct adapter upstream after our supported Node 22 line;
// this projection can disappear once our minimum runtime includes that fix.
// https://github.com/nodejs/node/blob/aa4c77582be995286fc6e00aaf530dc7ade102a9/lib/internal/webstreams/adapters.js#L424-L502
// https://github.com/nodejs/node/blob/783b3824831053fb020c17d456505ed76dfaef87/lib/internal/webstreams/adapters.js#L500-L527
// https://github.com/nodejs/node/blob/aa4c77582be995286fc6e00aaf530dc7ade102a9/lib/internal/streams/pipeline.js#L213-L267
export const socketToReadable = (socket: net.Socket): ReadableStream<Uint8Array> => {
  const readable = new PassThrough({ highWaterMark: socket.readableHighWaterMark });
  pipeline(socket, readable, error => {
    // pipeline has already propagated the error into readable; keep the
    // callback as a final invariant guard for non-standard stream behavior.
    if (error && !readable.errored) readable.destroy(error);
  });
  return Readable.toWeb(readable) as ReadableStream<Uint8Array>;
};

// Hand-rolled adapter from a Node duplex socket to a WritableStream.
// Writable.toWeb only wires `close()` to socket.end(); writer.abort() is
// routed through the same end-of-stream path and leaves the underlying
// socket alive in a half-open state. Our proxy runners depend on
// cancellation actually destroying the socket so the inner-TLS stack
// stops trying to drain a dead leg, so we drive the four lifecycle hooks
// ourselves: write awaits the chunk callback (which fires once the chunk
// is flushed and naturally backpressures behind socket buffering), close
// half-closes the write side, abort destroys the socket, and a socket
// 'error' propagates into the writer via controller.error().
export const socketToWritable = (socket: net.Socket): WritableStream<Uint8Array> => {
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
