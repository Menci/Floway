import type { SSEStreamingApi } from 'hono/streaming';

import type { SseFrame, SseWritableFrame } from '@floway-dev/protocols/common';

export const DOWNSTREAM_KEEP_ALIVE_INTERVAL_MS = 15_000;

interface SseKeepAliveOptions {
  intervalMs?: number;
  frame: SseWritableFrame;
}

interface SseStreamOptions {
  keepAlive?: SseKeepAliveOptions;
  clientDisconnectController?: AbortController;
}

type ResolvedSseKeepAliveOptions = Required<SseKeepAliveOptions>;

type NextFrameResult = { type: 'frame'; result: IteratorResult<SseFrame> } | { type: 'next-error'; error: unknown } | { type: 'keep-alive' } | { type: 'abort' };

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

const signalAbortPromise = (signal: AbortSignal | undefined): Promise<void> => {
  if (signal === undefined) return new Promise(() => {});
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
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

const drainSSEFrames = async (
  stream: SSEStreamingApi,
  events: AsyncIterable<SseFrame>,
  keepAlive: ResolvedSseKeepAliveOptions | undefined,
  clientDisconnectController: AbortController | undefined,
): Promise<StreamCompletion> => {
  const iterator = events[Symbol.asyncIterator]();
  let clientDisconnected = false;
  const recordClientDisconnect = () => {
    clientDisconnected = true;
    if (!clientDisconnectController?.signal.aborted) {
      clientDisconnectController?.abort();
    }
  };
  const abortResult = Promise.race([
    streamAbortPromise(stream),
    signalAbortPromise(clientDisconnectController?.signal),
  ]).then((): NextFrameResult => {
    recordClientDisconnect();
    return { type: 'abort' };
  });
  let pendingNext = pendingFrameResult(iterator.next());
  let completed = false;

  try {
    while (true) {
      if (!clientDisconnected && (stream.aborted || stream.closed)) {
        recordClientDisconnect();
      }

      const next = clientDisconnected
        ? await pendingNext
        : await nextFrameOrKeepAlive(pendingNext, abortResult, keepAlive);

      if (next.type === 'abort') {
        recordClientDisconnect();
        continue;
      }
      if (next.type === 'keep-alive') {
        if (!keepAlive) continue;
        await writeSSEFrame(stream, keepAlive.frame);
        continue;
      }
      if (next.type === 'next-error') {
        throw next.error;
      }

      if (next.result.done) {
        completed = true;
        return clientDisconnected ? 'cancel' : 'eof';
      }

      if (!clientDisconnected) {
        try {
          await writeSSEFrame(stream, next.result.value);
        } catch (error) {
          if (stream.aborted || stream.closed) recordClientDisconnect();
          else throw error;
        }
      }
      pendingNext = pendingFrameResult(iterator.next());
    }
  } finally {
    if (!completed) await iterator.return?.();
  }
};

export const writeSSEFrames = async (stream: SSEStreamingApi, events: AsyncIterable<SseFrame>, options: SseStreamOptions = {}): Promise<StreamCompletion> => {
  const keepAlive = resolveKeepAliveOptions(options.keepAlive);
  return await drainSSEFrames(stream, events, keepAlive, options.clientDisconnectController);
};
