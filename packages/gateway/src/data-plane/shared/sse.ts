import type { SSEStreamingApi } from 'hono/streaming';

import type { SseFrame, SseWritableFrame } from '@floway-dev/protocols/common';

export const DOWNSTREAM_KEEP_ALIVE_INTERVAL_MS = 15_000;

interface SseKeepAliveOptions {
  intervalMs?: number;
  frame: SseWritableFrame;
}

interface SseStreamOptions {
  keepAlive?: SseKeepAliveOptions;
  downstreamAbortController?: AbortController;
}

type ResolvedSseKeepAliveOptions = Required<SseKeepAliveOptions>;

type NextFrameResult = { type: 'frame'; result: IteratorResult<SseFrame> } | { type: 'next-error'; error: unknown } | { type: 'keep-alive' } | { type: 'abort' };
type StreamFailure = { readonly error: unknown };

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

const pendingFrameResult = (pendingNext: Promise<IteratorResult<SseFrame>>): Promise<NextFrameResult> =>
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

const cleanupFailure = (failure: StreamFailure, cleanupError: unknown): AggregateError => {
  const message = failure.error instanceof Error ? failure.error.message : String(failure.error);
  return new AggregateError([failure.error, cleanupError], message, { cause: failure.error });
};

const drainSSEFrames = async (
  stream: SSEStreamingApi,
  events: AsyncIterable<SseFrame>,
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
  let failure: StreamFailure | undefined;

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
      pendingNext = pendingFrameResult(iterator.next());
    }
  } catch (error) {
    failure = { error };
    abortDownstream();
    throw error;
  } finally {
    if (!completed) {
      // A downstream cancellation must not wait behind an iterator whose
      // current next() never settles. Start its cleanup, consume any rejection,
      // and let the transport finish immediately because it has nowhere to
      // report a cleanup failure.
      if (stoppedByDownstream) {
        try {
          iterator.return?.().catch(() => {});
        } catch {
          // A synchronous cleanup failure is equally unactionable here.
        }
      } else {
        try {
          await iterator.return?.();
        } catch (cleanupError) {
          if (failure !== undefined) throw cleanupFailure(failure, cleanupError);
          throw cleanupError;
        }
      }
    }
  }
};

export const writeSSEFrames = async (stream: SSEStreamingApi, events: AsyncIterable<SseFrame>, options: SseStreamOptions = {}): Promise<StreamCompletion> => {
  const keepAlive = resolveKeepAliveOptions(options.keepAlive);
  return await drainSSEFrames(stream, events, keepAlive, options.downstreamAbortController);
};
