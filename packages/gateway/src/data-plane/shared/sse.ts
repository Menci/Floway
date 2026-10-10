import type { SSEStreamingApi } from 'hono/streaming';

import type { SseWritableFrame } from '@floway-dev/protocols/common';

export const DOWNSTREAM_KEEP_ALIVE_INTERVAL_MS = 15_000;

interface SseKeepAliveOptions {
  intervalMs?: number;
  frame: Exclude<SseWritableFrame, { type: 'sse-trailer' }>;
}

interface SseStreamOptions {
  keepAlive?: SseKeepAliveOptions;
  downstreamAbortController?: AbortController;
}

type ResolvedSseKeepAliveOptions = Required<SseKeepAliveOptions>;

type NextFrameResult = { type: 'frame'; result: IteratorResult<SseWritableFrame> } | { type: 'next-error'; error: unknown } | { type: 'keep-alive' } | { type: 'abort' };

export type StreamCompletion = 'eof' | 'error' | 'cancel';

const resolveKeepAliveOptions = (keepAlive: SseKeepAliveOptions | undefined): ResolvedSseKeepAliveOptions | undefined => {
  if (!keepAlive) return undefined;

  const intervalMs = keepAlive.intervalMs ?? DOWNSTREAM_KEEP_ALIVE_INTERVAL_MS;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error('SSE keepalive interval must be a positive number');
  }

  return { intervalMs, frame: keepAlive.frame };
};

const serializeSSECommentFrame = (comment: string): string =>
  `${comment
    .split(/\r\n|\r|\n/)
    .map(line => `: ${line}`)
    .join('\n')}\n\n`;

const writeSSEFrame = async (stream: SSEStreamingApi, frame: SseWritableFrame): Promise<void> => {
  if (stream.aborted || stream.closed) return;

  if (frame.type === 'sse-trailer') {
    await stream.write(frame.data);
    return;
  }

  if (frame.type === 'sse-comment') {
    await stream.write(serializeSSECommentFrame(frame.comment));
    return;
  }

  await stream.writeSSE({
    event: frame.event,
    data: frame.data,
  });
};

const streamAbortPromise = (stream: SSEStreamingApi): Promise<void> => {
  if (stream.aborted || stream.closed) return Promise.resolve();

  return new Promise(resolve => {
    stream.onAbort(resolve);
  });
};

const pendingFrameResult = (pendingNext: Promise<IteratorResult<SseWritableFrame>>): Promise<NextFrameResult> =>
  pendingNext.then(
    (result): NextFrameResult => ({ type: 'frame', result }),
    (error): NextFrameResult => ({ type: 'next-error', error }),
  );

const nextFrameOrKeepAlive = async (
  pendingFrame: Promise<NextFrameResult>,
  pendingAbort: Promise<NextFrameResult>,
  keepAlive: ResolvedSseKeepAliveOptions | undefined,
): Promise<NextFrameResult> => {
  if (!keepAlive) return await Promise.race([pendingFrame, pendingAbort]);

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const pendingKeepAlive = new Promise<{ type: 'keep-alive' }>(resolve => {
    timeoutId = setTimeout(() => {
      timeoutId = undefined;
      resolve({ type: 'keep-alive' });
    }, keepAlive.intervalMs);
  });

  try {
    return await Promise.race([pendingFrame, pendingAbort, pendingKeepAlive]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
};

const drainSSEFrames = async (
  stream: SSEStreamingApi,
  events: AsyncIterable<SseWritableFrame>,
  keepAlive: ResolvedSseKeepAliveOptions | undefined,
  downstreamAbortController: AbortController | undefined,
): Promise<StreamCompletion> => {
  const iterator = events[Symbol.asyncIterator]();
  const abortDownstream = () => {
    if (!downstreamAbortController?.signal.aborted) {
      downstreamAbortController?.abort();
    }
  };
  const abortResult = streamAbortPromise(stream).then((): NextFrameResult => {
    abortDownstream();
    return { type: 'abort' };
  });
  let pendingNext = pendingFrameResult(iterator.next());
  let completed = false;
  let stoppedByDownstream = false;

  const stopForDownstream = () => {
    stoppedByDownstream = true;
    abortDownstream();
  };

  try {
    while (true) {
      if (stream.aborted || stream.closed) {
        stopForDownstream();
        return 'cancel';
      }

      const next = await nextFrameOrKeepAlive(pendingNext, abortResult, keepAlive);

      if (next.type === 'abort') {
        stopForDownstream();
        return 'cancel';
      }
      if (next.type === 'keep-alive') {
        if (!keepAlive) continue;
        await writeSSEFrame(stream, keepAlive.frame);
        continue;
      }
      if (next.type === 'next-error') {
        if (stream.aborted || stream.closed) {
          stopForDownstream();
          return 'cancel';
        }
        throw next.error;
      }

      if (next.result.done) {
        completed = true;
        return 'eof';
      }

      await writeSSEFrame(stream, next.result.value);
      if (stream.aborted || stream.closed) {
        stopForDownstream();
        return 'cancel';
      }
      if (next.result.value.type === 'sse-trailer') return 'eof';
      pendingNext = pendingFrameResult(iterator.next());
    }
  } finally {
    if (!completed) {
      const stopped = iterator.return?.();
      // Downstream already cancelled; cleanup errors from the upstream
      // iterator have nowhere to surface to. Awaiting the rejection would
      // leak it as an unhandled rejection.
      if (stoppedByDownstream) stopped?.catch(() => {});
      else await stopped;
    }
  }
};

export const writeSSEFrames = async (stream: SSEStreamingApi, events: AsyncIterable<SseWritableFrame>, options: SseStreamOptions = {}): Promise<StreamCompletion> => {
  const keepAlive = resolveKeepAliveOptions(options.keepAlive);
  return await drainSSEFrames(stream, events, keepAlive, options.downstreamAbortController);
};
