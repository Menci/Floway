import { createParser } from 'eventsource-parser';

import { type SseReadableFrame, sseFrame, sseRawFrame } from './sse.ts';

interface ParseSSEStreamOptions {
  signal?: AbortSignal | undefined;
}

export const parseSSEStream = async function* (body: ReadableStream<Uint8Array>, options: ParseSSEStreamOptions = {}): AsyncGenerator<SseReadableFrame> {
  const reader = body.getReader();
  const { signal } = options;
  const decoder = new TextDecoder();
  let pendingFrames: SseReadableFrame[] = [];
  let cancelPromise: Promise<void> | undefined;

  const parser = createParser({
    onEvent: event => {
      // `bare` marks a payload the SSE grammar never claimed — an unframed
      // body some upstreams write for a late error. Forwarding it as a raw
      // frame keeps the framing visible to callers that act on it.
      pendingFrames.push(event.bare === true ? sseRawFrame(event.data) : sseFrame(event.data, event.event));
    },
  });

  const takePendingFrames = (): SseReadableFrame[] => {
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
