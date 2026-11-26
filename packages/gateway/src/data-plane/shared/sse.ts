import type { Context } from 'hono';
import { type SSEStreamingApi, streamSSE } from 'hono/streaming';

import { prepareSseResponse } from './upstream-response.ts';
import { type SseWritableFrame, sseCommentFrame } from '@floway-dev/protocols/common';
import type { HttpHead } from '@floway-dev/upstream';

export const DOWNSTREAM_KEEP_ALIVE_INTERVAL_MS = 15_000;

interface SseKeepAliveOptions {
  intervalMs?: number;
  frame: SseWritableFrame;
}

interface SseFinished {
  type: 'completed' | 'protocol-error';
  trailer?: readonly string[];
}

type SseEnd = SseFinished | { type: 'premature-eof'; error: Error };

export interface SseProtocol<T> {
  encode: (input: T) => { wire: string | null; end?: SseEnd };
  eof: () => SseEnd;
  failure: (error: unknown) => readonly [string, ...string[]];
}

export type SseOutcome =
  | { type: 'completed' | 'protocol-error' | 'cancelled' }
  | { type: 'source-error' | 'premature-eof' | 'egress-error'; error: unknown };

interface SseStreamOptions<T> {
  http?: HttpHead | undefined;
  events: AsyncIterable<T>;
  protocol: SseProtocol<T>;
  keepAlive?: SseKeepAliveOptions;
  downstreamAbortController: AbortController | undefined;
  settle: (outcome: SseOutcome) => void | Promise<void>;
}

type NextFrame<T> = { type: 'frame'; result: IteratorResult<T> } | { type: 'source-error'; error: unknown };

export const serializeSseFrame = (frame: SseWritableFrame): string => {
  if (frame.type === 'sse-raw') return frame.data;
  if (frame.type === 'sse-comment') {
    return `${frame.comment.split(/\r\n|\r|\n/).map(line => `: ${line}`).join('\n')}\n\n`;
  }
  if (frame.event !== undefined && /[\r\n]/.test(frame.event)) {
    throw new Error('SSE event name cannot contain CR or LF');
  }
  const event = frame.event ? `event: ${frame.event}\n` : '';
  const data = frame.data.split(/\r\n|\r|\n/).map(line => `data: ${line}`).join('\n');
  return `${event}${data}\n\n`;
};

const drainSse = async <T>(
  stream: SSEStreamingApi,
  { events, protocol, downstreamAbortController }: SseStreamOptions<T>,
  keepAlive: { intervalMs: number; wire: string },
): Promise<SseOutcome> => {
  let iterator: AsyncIterator<T> | undefined;
  let wake: (() => void) | undefined;
  let egressFailed = false;
  const disconnected = () => stream.aborted || stream.closed;
  const write = async (wire: string): Promise<void> => {
    if (!disconnected()) await stream.write(wire);
  };
  stream.onAbort(() => {
    downstreamAbortController?.abort();
    wake?.();
  });

  // Keep one listener on the pending read even when several heartbeats elapse.
  const read = async (source: AsyncIterator<T>): Promise<NextFrame<T> | undefined> => {
    let next: NextFrame<T> | undefined;
    const ready = (value: NextFrame<T>) => {
      next = value;
      wake?.();
    };
    void Promise.resolve().then(() => source.next()).then(
      result => ready({ type: 'frame', result }),
      error => ready({ type: 'source-error', error }),
    );
    while (!next && !disconnected()) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, keepAlive.intervalMs);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wake = undefined;
      if (!next) await write(keepAlive.wire);
    }
    return disconnected() ? undefined : next;
  };

  const fail = async (error: unknown, type: 'source-error' | 'premature-eof' = 'source-error'): Promise<SseOutcome> => {
    if (disconnected()) return { type: 'cancelled' };
    try {
      for (const wire of protocol.failure(error)) await write(wire);
    } catch (egressError) {
      throw new AggregateError([error, egressError], 'Failed to send the SSE failure', { cause: error });
    }
    return { type, error };
  };

  const finish = async (end: SseEnd): Promise<SseOutcome> => {
    if (end.type === 'premature-eof') return await fail(end.error, end.type);
    for (const wire of end.trailer ?? []) await write(wire);
    return { type: end.type };
  };

  const closeIterator = async (source: AsyncIterator<T>) => {
    try {
      await source.return?.();
    } catch (error) {
      console.error('Failed to close the SSE source iterator:', error);
    }
  };

  try {
    if (disconnected()) return { type: 'cancelled' };
    try {
      iterator = events[Symbol.asyncIterator]();
    } catch (error) {
      return await fail(error);
    }
    while (true) {
      if (disconnected()) return { type: 'cancelled' };
      const next = await read(iterator);
      if (!next || disconnected()) return { type: 'cancelled' };
      if (next.type === 'source-error') return await fail(next.error);
      if (next.result.done) {
        iterator = undefined;
        let end: SseEnd;
        try {
          end = protocol.eof();
        } catch (error) {
          return await fail(error);
        }
        return await finish(end);
      }

      let output: ReturnType<SseProtocol<T>['encode']>;
      try {
        output = protocol.encode(next.result.value);
      } catch (error) {
        return await fail(error);
      }
      if (output.wire !== null) await write(output.wire);
      if (output.end) return await finish(output.end);
    }
  } catch (error) {
    egressFailed = true;
    downstreamAbortController?.abort(error);
    console.error('SSE egress failed:', error);
    return { type: 'egress-error', error };
  } finally {
    if (iterator) {
      const stopped = closeIterator(iterator);
      if (disconnected() || egressFailed) void stopped;
      else await stopped;
    }
  }
};

export const serveSse = <T>(c: Context, options: SseStreamOptions<T>): Response => {
  const keepAlive = {
    intervalMs: options.keepAlive?.intervalMs ?? DOWNSTREAM_KEEP_ALIVE_INTERVAL_MS,
    wire: serializeSseFrame(options.keepAlive?.frame ?? sseCommentFrame('keepalive')),
  };
  if (!Number.isFinite(keepAlive.intervalMs) || keepAlive.intervalMs <= 0) {
    throw new Error('SSE keepalive interval must be a positive number');
  }
  prepareSseResponse(c, options.http);
  return streamSSE(c, async stream => {
    const outcome = await drainSse(stream, options, keepAlive);
    await options.settle(outcome);
  });
};
