import { isCloudflareNetworkFailure } from './network-failure.ts';
import { HttpTransportError } from '@floway-dev/http';

const identify = (cause: unknown): unknown => isCloudflareNetworkFailure(cause) ? new HttpTransportError(cause) : cause;

export const cloudflareSocketReadable = (source: ReadableStream<Uint8Array>) => {
  const reader = source.getReader();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let finished = false;
  const fail = (cause: unknown): void => {
    if (finished) return;
    finished = true;
    controller.error(cause);
  };
  void reader.closed.catch((cause: unknown) => {
    if (finished) return;
    fail(identify(cause));
    reader.releaseLock();
  });
  const readable = new ReadableStream<Uint8Array>({
    start(output) { controller = output; },
    async pull() {
      try {
        const item = await reader.read();
        if (finished) return;
        if (item.done) {
          finished = true;
          reader.releaseLock();
          controller.close();
        } else {
          controller.enqueue(item.value);
        }
      } catch (cause) {
        if (finished) return;
        fail(identify(cause));
        reader.releaseLock();
      }
    },
    async cancel(reason) {
      finished = true;
      try { await reader.cancel(reason); } finally { reader.releaseLock(); }
    },
  }, { highWaterMark: 0 });

  return {
    readable,
    async abort(reason: Error) {
      if (finished) return;
      fail(reason);
      // Workerd requires pending reads to settle before the lock can be released.
      try { await reader.cancel(reason); } finally { reader.releaseLock(); }
    },
  };
};

export const cloudflareSocketWritable = (source: WritableStream<Uint8Array>) => {
  const writer = source.getWriter();
  let controller!: WritableStreamDefaultController;
  let stopped: ((cause: unknown) => void) | undefined;
  let finished = false;
  const fail = (cause: unknown): void => {
    if (finished) return;
    finished = true;
    stopped?.(cause);
    controller.error(cause);
    writer.releaseLock();
  };
  void writer.closed.catch((cause: unknown) => fail(identify(cause)));
  const finish = async (operation: Promise<void>): Promise<void> => {
    try { await operation; } finally {
      finished = true;
      writer.releaseLock();
    }
  };
  const writable = new WritableStream<Uint8Array>({
    start(output) { controller = output; },
    async write(chunk) {
      const interruption = new Promise<never>((_, reject) => { stopped = reject; });
      const write = writer.write(chunk);
      try {
        await Promise.race([write, interruption]);
      } catch (cause) {
        if (finished) throw cause;
        const error = identify(cause);
        fail(error);
        throw error;
      } finally {
        stopped = undefined;
      }
    },
    close: () => finish(writer.close()),
    abort: reason => finish(writer.abort(reason)),
  });
  return { writable, abort: fail };
};
