import { createParser } from 'eventsource-parser';

import { type SseFrame, sseFrame } from './sse.ts';

interface ParseSSEStreamOptions {
  signal?: AbortSignal;
}

export const parseSSEStream = async function* (body: ReadableStream<Uint8Array>, options: ParseSSEStreamOptions = {}): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const { signal } = options;
  const decoder = new TextDecoder();
  let pendingFrames: SseFrame[] = [];
  let cancelPromise: Promise<void> | undefined;

  const parser = createParser({
    onEvent: event => {
      pendingFrames.push(sseFrame(event.data, event.event));
    },
  });

  const takePendingFrames = (): SseFrame[] => {
    const frames = pendingFrames;
    pendingFrames = [];
    return frames;
  };

  const cancelReader = (reason?: unknown): Promise<void> => {
    cancelPromise ??= reader.cancel(reason).catch(() => {});
    return cancelPromise;
  };

  const cancelReaderOnAbort = () => {
    void cancelReader(signal?.reason);
  };

  if (signal?.aborted) {
    await cancelReader(signal.reason);
    return;
  }

  signal?.addEventListener('abort', cancelReaderOnAbort, { once: true });

  try {
    while (true) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (signal?.aborted) return;
      if (done) break;

      parser.feed(decoder.decode(value, { stream: true }));
      yield* takePendingFrames();
    }

    const finalChunk = decoder.decode();
    if (finalChunk) parser.feed(finalChunk);
    // Preserve the existing contract that a final data line is consumable even
    // when its peer closes without writing the terminating blank line.
    parser.feed('\n\n');
    yield* takePendingFrames();
  } finally {
    signal?.removeEventListener('abort', cancelReaderOnAbort);
    await (cancelPromise ?? reader.cancel());
  }
};
