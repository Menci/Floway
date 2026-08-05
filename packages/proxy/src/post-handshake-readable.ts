import { copy } from './bytes.ts';
import type { DialedSocket } from './types.ts';

/**
 * Hand a protocol reader to its tunneled consumer after the handshake has
 * peeled its own bytes. Initial bytes are detached from the handshake buffer;
 * subsequent reads remain demand-driven, and every terminal path releases the
 * borrowed reader and closes the socket.
 */
export const postHandshakeReadable = (
  socket: DialedSocket,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  remainder: Uint8Array,
): ReadableStream<Uint8Array> => {
  let initial = copy(remainder);
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    try { reader.releaseLock(); } catch { /* lock already released */ }
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (initial.byteLength) controller.enqueue(initial);
      initial = new Uint8Array(0);
    },
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          controller.close();
          release();
          void socket.close().catch(() => {});
        } else {
          controller.enqueue(copy(result.value));
        }
      } catch (error) {
        release();
        void socket.close().catch(() => {});
        throw error;
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason); } catch { /* reader already cancelled */ } finally {
        release();
        await socket.close().catch(() => {});
      }
    },
  });
};
