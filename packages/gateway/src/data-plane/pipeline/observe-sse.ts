import type { AttemptResponse } from './failover.ts';
import { forwardHttp, openAiApiError, scalarHttpAttempt } from './non-chat.ts';
import { billableCall, type BillableCall, type ObservedUsage } from './observe-usage.ts';
import { openaiInternalErrorPayload } from '../shared/openai-error-payload.ts';
import { DOWNSTREAM_KEEP_ALIVE_INTERVAL_MS, serializeSseFrame } from '../shared/sse.ts';
import type { HttpResponseFacts } from '@floway-dev/http';
import { Bytes, type StageEnv } from '@floway-dev/pipeline';
import { sseCommentFrame, sseFrame } from '@floway-dev/protocols/common';
import { type TelemetryModelIdentity, toInternalDebugError } from '@floway-dev/provider';

const asReadable = (source: AsyncIterable<Bytes>): ReadableStream<Uint8Array> => {
  const iterator = source[Symbol.asyncIterator]();
  return new ReadableStream({
    pull: async controller => {
      const { done, value } = await iterator.next();
      if (done) controller.close();
      else controller.enqueue(value.toUint8Array());
    },
    cancel: async () => { await iterator.return?.(); },
  }, { highWaterMark: 0 });
};

const keepAlive = Symbol('SSE keep-alive');

async function* withKeepAlive<Frame>(events: AsyncIterable<Frame>, signal: AbortSignal): AsyncGenerator<Frame | typeof keepAlive> {
  const iterator = events[Symbol.asyncIterator]();
  try {
    for (;;) {
      let wake: (() => void) | undefined;
      type Read = { readonly result: IteratorResult<Frame> } | { readonly error: unknown };
      let ready: Read | undefined;
      const settle = (result: Read) => {
        ready = result;
        wake?.();
      };
      void iterator.next().then(result => settle({ result }), error => settle({ error }));
      while (ready === undefined && !signal.aborted) {
        await new Promise<void>(resolve => {
          const release = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', release);
            resolve();
          };
          const timer = setTimeout(release, DOWNSTREAM_KEEP_ALIVE_INTERVAL_MS);
          wake = release;
          signal.addEventListener('abort', release, { once: true });
        });
        wake = undefined;
        if (ready === undefined && !signal.aborted) yield keepAlive;
      }
      if (signal.aborted || ready === undefined) return;
      if ('error' in ready) throw ready.error;
      if (ready.result.done) return;
      yield ready.result.value;
    }
  } finally {
    await iterator.return?.();
  }
}

interface SseDialect<Frame> {
  readonly frames: (body: ReadableStream<Uint8Array>, signal: AbortSignal) => AsyncIterable<Frame>;
  readonly encode: (frame: Frame) => { readonly wire: string | null; readonly end?: 'completed' | 'stream-error' };
  readonly eofMessage: string;
  readonly usage: () => ObservedUsage;
}

const keepAliveFrame = Bytes.fromUtf8(serializeSseFrame(sseCommentFrame('keepalive')));

export const observeSse = <Frame>(
  http: HttpResponseFacts, identity: TelemetryModelIdentity, env: StageEnv, dialect: SseDialect<Frame>,
): AttemptResponse => {
  const { body } = http;
  const forwarded = forwardHttp(http);
  if (body === null) {
    const error = openAiApiError(502, 'Upstream returned a streaming response with no body.', env.clock());
    const headers = forwarded.headers.filter(([name]) => name !== 'content-type');
    return scalarHttpAttempt(env, { ...error, headers: [...headers, ...error.headers] }, identity, dialect.usage());
  }
  const source = body instanceof Bytes ? env.createStream({ label: 'buffered upstream SSE', async *iterate() { yield body; } }) : body;
  let disposition: BillableCall['disposition'] = 'released';
  const stream = env.wrapStream(source, {
    label: 'downstream SSE frames',
    async *transform(input, signal) {
      try {
        for await (const frame of withKeepAlive(dialect.frames(asReadable(input), signal), signal)) {
          if (frame === keepAlive) {
            yield keepAliveFrame;
            continue;
          }
          const encoded = dialect.encode(frame);
          if (encoded.end !== undefined) disposition = encoded.end;
          if (encoded.wire !== null) yield Bytes.fromUtf8(encoded.wire);
          if (encoded.end !== undefined) return;
        }
        if (!signal.aborted) throw new Error(dialect.eofMessage);
      } catch (error) {
        if (signal.aborted) return;
        disposition = 'stream-error';
        yield Bytes.fromUtf8(serializeSseFrame(sseFrame(JSON.stringify(openaiInternalErrorPayload(toInternalDebugError(error))))));
      }
    },
    onClose(end) {
      streamEnd.resolve(env.clock());
      if (end.how === 'cancelled') disposition = 'cancelled';
      else if (end.how === 'leaked' || end.how === 'errored') disposition = 'stream-error';
      try {
        billing.resolve([billableCall(env, identity, disposition, dialect.usage())]);
      } catch (error) {
        billing.reject(error);
      }
    },
  });
  const billing = env.deferred<readonly BillableCall[]>('billable call', stream);
  const streamEnd = env.deferred<number | null>('stream end', stream);
  const headers = forwarded.headers.filter(([name]) => !['content-type', 'cache-control'].includes(name.toLowerCase()));
  return {
    'response.http': { ...forwarded, headers: [...headers, ['content-type', 'text/event-stream'], ['cache-control', 'no-cache'], ['connection', 'keep-alive']], body: stream },
    'response.usage.billable': billing.deferred,
    'response.timing.firstOutputAt': env.defer('first output', Promise.resolve(null)),
    'response.timing.streamEndedAt': streamEnd.deferred,
  };
};
