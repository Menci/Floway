import type { LogStream } from './log-stream.ts';

const LENGTH_PREFIX_BYTES = 4;

/**
 * Serves a live log stream with its own framing:
 * `[uint32 length][bytes]... [uint32 0]`. The terminal frame distinguishes a
 * clean stream end from an interrupted body, which HTTP response bodies do not.
 */
export const serveLogStream = (stream: LogStream, fromOffset: number, signal: AbortSignal): Response => {
  const readController = new AbortController();
  const forwardAbort = (): void => { readController.abort(signal.reason); };
  if (signal.aborted) forwardAbort();
  else signal.addEventListener('abort', forwardAbort, { once: true });

  const iterator = stream.read(fromOffset, readController.signal)[Symbol.asyncIterator]();
  let cancelled = false;
  let completion: Promise<void> | null = null;
  const finish = (): void => {
    signal.removeEventListener('abort', forwardAbort);
  };
  const stopIterator = (): Promise<void> => {
    completion ??= (async () => {
      await iterator.return?.();
      finish();
    })();
    return completion;
  };

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        for (;;) {
          const { done, value } = await iterator.next();
          if (cancelled) {
            await stopIterator();
            return;
          }
          if (done) {
            controller.enqueue(new Uint8Array(LENGTH_PREFIX_BYTES));
            controller.close();
            await stopIterator();
            return;
          }
          if (value.byteLength === 0) continue;

          const header = new Uint8Array(LENGTH_PREFIX_BYTES);
          new DataView(header.buffer).setUint32(0, value.byteLength, false);
          controller.enqueue(header);
          controller.enqueue(value);
          return;
        }
      } catch {
        if (!cancelled) controller.close();
        await stopIterator();
      }
    },
    async cancel(reason) {
      cancelled = true;
      readController.abort(reason);
      await stopIterator();
    },
  }, { highWaterMark: 0 });

  return new Response(body, { headers: { 'content-type': 'application/octet-stream' } });
};

export class LogStreamTruncatedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LogStreamTruncatedError';
  }
}

/**
 * Reassembles the stream yielded by {@link serveLogStream}. Incoming network
 * fragments stay in a queue and each byte is copied once into the header view
 * or a preallocated frame buffer.
 */
export const readLogStream = async function* (response: Response): AsyncGenerator<Uint8Array> {
  if (response.body === null) throw new LogStreamTruncatedError('log stream response carried no body');

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let headIndex = 0;
  let headOffset = 0;
  let bufferedBytes = 0;

  const append = (piece: Uint8Array): void => {
    if (piece.byteLength === 0) return;
    chunks.push(piece);
    bufferedBytes += piece.byteLength;
  };

  const fill = async (count: number): Promise<Uint8Array | null> => {
    while (bufferedBytes < count) {
      const { done, value } = await reader.read();
      if (done) return null;
      append(value);
    }

    const output = new Uint8Array(count);
    let outputOffset = 0;
    while (outputOffset < count) {
      const head = chunks[headIndex]!;
      const available = head.byteLength - headOffset;
      const take = Math.min(available, count - outputOffset);
      output.set(head.subarray(headOffset, headOffset + take), outputOffset);
      outputOffset += take;
      headOffset += take;
      bufferedBytes -= take;
      if (headOffset === head.byteLength) {
        headIndex++;
        headOffset = 0;
        if (headIndex === chunks.length) {
          chunks.length = 0;
          headIndex = 0;
        }
      }
    }
    return output;
  };

  let completed = false;
  try {
    for (;;) {
      const header = await fill(LENGTH_PREFIX_BYTES);
      if (header === null) {
        throw new LogStreamTruncatedError(
          `log stream body ended ${bufferedBytes} bytes into a ${LENGTH_PREFIX_BYTES}-byte frame header`,
        );
      }

      const frameLength = new DataView(header.buffer).getUint32(0, false);
      if (frameLength === 0) {
        completed = true;
        return;
      }

      const frame = await fill(frameLength);
      if (frame === null) {
        throw new LogStreamTruncatedError(
          `log stream body ended ${bufferedBytes} bytes into a ${frameLength}-byte frame`,
        );
      }
      yield frame;
    }
  } finally {
    if (!completed) {
      const results = await Promise.allSettled([reader.cancel()]);
      const failure = results.find(result => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    }
    reader.releaseLock();
  }
};
