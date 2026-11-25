import { markTransportFailure } from '@floway-dev/http';

export const cloudflareSocketReadable = (source: ReadableStream<Uint8Array>) => {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
  let cancelled = false;
  const readable = new ReadableStream<Uint8Array>({
    start(output) { controller = output; },
    async pull() {
      const current = reader ??= source.getReader();
      const read = current.read();
      pending = read;
      try {
        const item = await read;
        if (cancelled) return;
        if (item.done) {
          current.releaseLock();
          controller.close();
        } else {
          controller.enqueue(item.value);
        }
      } catch (cause) {
        if (cancelled) return;
        current.releaseLock();
        controller.error(markTransportFailure(cause));
      } finally {
        pending = undefined;
      }
    },
    async cancel(reason) {
      cancelled = true;
      if (reader === undefined) {
        await source.cancel(reason);
        return;
      }
      try {
        await reader.cancel(reason);
      } finally {
        reader.releaseLock();
      }
    },
  }, { highWaterMark: 0 });

  const abortPendingRead = async (reason: Error): Promise<void> => {
    const read = pending;
    const current = reader;
    if (read === undefined || current === undefined) return;
    // Let a read already settled by the socket report its own result before
    // marking this particular outstanding read as cancelled.
    await Promise.resolve();
    if (read !== pending) return;
    cancelled = true;
    controller.error(reason);
    // Socket.close can interrupt an underlying cancel that is still waiting for its I/O.
    void current.cancel(reason).finally(() => { current.releaseLock(); }).catch(() => undefined);
  };

  return { readable, abortPendingRead };
};
