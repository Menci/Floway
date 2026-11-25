import { createParser } from 'eventsource-parser';

import { type SseReadableFrame, sseFrame, sseRawFrame } from './sse.ts';
import type { Result } from '@floway-dev/pipeline';

interface ParseSSEStreamOptions {
  signal?: AbortSignal | undefined;
}

const sseDecoder = () => {
  const decoder = new TextDecoder();
  let pendingFrames: SseReadableFrame[] = [];

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

  return {
    feed(bytes: Uint8Array) {
      parser.feed(decoder.decode(bytes, { stream: true }));
      return takePendingFrames();
    },
    finish() {
      // Some upstreams close immediately after their final data line.
      parser.feed(`${decoder.decode()}\n\n`);
      return takePendingFrames();
    },
  };
};

export const parseSseFrames = async function* <Failure>(
  body: AsyncIterable<Result<Uint8Array, Failure>>,
): AsyncGenerator<Result<SseReadableFrame, Failure>, void, unknown> {
  const decoder = sseDecoder();
  for await (const item of body) {
    if (!item.ok) {
      yield item;
      return;
    }
    for (const frame of decoder.feed(item.value)) yield { ok: true, value: frame };
  }
  for (const frame of decoder.finish()) yield { ok: true, value: frame };
};

export const parseSSEStream = async function* (body: ReadableStream<Uint8Array>, options: ParseSSEStreamOptions = {}): AsyncGenerator<SseReadableFrame> {
  const reader = body.getReader();
  const { signal } = options;
  const decoder = sseDecoder();
  let cancelPromise: Promise<void> | undefined;

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

      yield* decoder.feed(value);
    }

    yield* decoder.finish();
  } finally {
    signal?.removeEventListener('abort', cancelReaderOnAbort);
    await (cancelPromise ?? reader.cancel());
  }
};
