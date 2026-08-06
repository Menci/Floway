import { copy } from './bytes.ts';
import type { DialedSocket } from './types.ts';
import { cleanupFailure, collectCleanupFailures, failureWithCleanup } from '@floway-dev/http/cleanup';

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
    reader.releaseLock();
    released = true;
  };
  let socketSettlement: Promise<void> | null = null;
  const closeSocket = (): Promise<void> => (socketSettlement ??= socket.close());
  let readerSettlement: Promise<readonly unknown[]> | null = null;
  const settleReader = (reason: unknown, cancelReader: boolean): Promise<readonly unknown[]> =>
    readerSettlement ??= Promise.all([
      collectCleanupFailures([
        ...(cancelReader ? [async () => await reader.cancel(reason)] : []),
        release,
      ]),
      collectCleanupFailures([closeSocket]),
    ]).then(([readerFailures, socketFailures]) => [...readerFailures, ...socketFailures]);

  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (initial.byteLength) controller.enqueue(initial);
      initial = new Uint8Array(0);
    },
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          const failures = await settleReader(undefined, false);
          if (failures.length > 0) {
            controller.error(cleanupFailure(failures, 'Tunnel EOF cleanup failed'));
          } else {
            controller.close();
          }
        } else {
          controller.enqueue(copy(result.value));
        }
      } catch (error) {
        const failures = await settleReader(error, false);
        throw failureWithCleanup(error, failures, 'Tunnel read and cleanup both failed');
      }
    },
    async cancel(reason) {
      const failures = await settleReader(reason, true);
      if (failures.length > 0) throw cleanupFailure(failures, 'Tunnel cancellation cleanup failed');
    },
  });
};
