import { billableCall, type BillableCall, type ObservedCallPerformance, type ObservedUsage, streamPerformance } from './call-metering.ts';
import { forwardHttp, header, type MeteredHttpResponse, openAiApiError, scalarHttpAttempt } from './non-chat.ts';
import { failedRender, type RenderOutcome } from './render.ts';
import { openaiInternalErrorPayload } from '../shared/openai-error-payload.ts';
import { DOWNSTREAM_KEEP_ALIVE_INTERVAL_MS, serializeSseFrame } from '../shared/sse.ts';
import { type HttpResponseFacts, isTransportFailure, type TransportFailure } from '@floway-dev/http';
import { Bytes, type Scope } from '@floway-dev/pipeline';
import { isEventStreamMediaType, sseCommentFrame, sseFrame, UpstreamStreamProtocolError } from '@floway-dev/protocols/common';
import { readHttpBody, type TelemetryModelIdentity, toInternalDebugError } from '@floway-dev/provider';

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
  readonly encode: (frame: Frame) => { readonly wire: string | null; readonly end?: 'completed' | 'protocol-error' };
  readonly eofMessage: string;
  readonly usage: () => ObservedUsage;
}

const keepAliveFrame = Bytes.fromUtf8(serializeSseFrame(sseCommentFrame('keepalive')));
const failureFrame = (error: unknown): Bytes =>
  Bytes.fromUtf8(serializeSseFrame(sseFrame(JSON.stringify(openaiInternalErrorPayload(toInternalDebugError(error))))));

const snippetLimit = 1024;
const formatSnippet = (text: string): string => {
  if (text.length === 0) return '<empty>';
  return text.length > snippetLimit ? `${text.slice(0, snippetLimit)}...[truncated]` : text;
};

const badStreamAttempt = (
  http: HttpResponseFacts, forwarded: HttpResponseFacts, identity: TelemetryModelIdentity,
  scope: Scope, usage: ObservedUsage, message: string,
): MeteredHttpResponse => {
  const error = openAiApiError(502, message, scope.clock());
  const headers = forwarded.headers.filter(([name]) => name.toLowerCase() !== 'content-type');
  return scalarHttpAttempt(scope, { ...http, status: error.status, statusText: '', headers: [...headers, ...error.headers], body: error.body }, identity, usage, failedRender('collect-error', new Error(message)));
};

export const observeSse = async <Frame>(
  http: HttpResponseFacts, identity: TelemetryModelIdentity, scope: Scope, dialect: SseDialect<Frame>,
): Promise<MeteredHttpResponse> => {
  const { body } = http;
  const forwarded = forwardHttp(http);
  if (body === null) {
    return badStreamAttempt(http, forwarded, identity, scope, dialect.usage(), 'Upstream returned a streaming response with no body.');
  }
  const contentType = header(http.headers, 'content-type');
  if (!isEventStreamMediaType(contentType)) {
    const raw = await readHttpBody(body);
    scope.signal.throwIfAborted();
    const snippet = raw.ok ? formatSnippet(raw.bytes.utf8()) : '<unreadable>';
    const message = `Upstream returned HTTP ${http.status} with content-type "${contentType ?? 'unknown'}" but a text/event-stream body is required. Body: ${snippet}`;
    return badStreamAttempt(http, forwarded, identity, scope, dialect.usage(), message);
  }
  const source = body instanceof Bytes ? scope.createStream({ label: 'buffered upstream SSE', async *iterate() { yield body; } }) : body;
  let outcome: RenderOutcome = { kind: 'completed' };
  let reachedTerminal = false;
  const stream = scope.wrapStream(source, {
    label: 'downstream SSE frames',
    async *transform(input, scope) {
      let interruption: { readonly failure: TransportFailure; readonly error: Error } | undefined;
      const bytes = async function* () {
        for await (const chunk of input) {
          if (isTransportFailure(chunk)) {
            interruption = { failure: chunk, error: new Error(chunk.error.message) };
            throw interruption.error;
          }
          yield chunk;
        }
      };
      try {
        for await (const frame of withKeepAlive(dialect.frames(asReadable(bytes()), scope.signal), scope.signal)) {
          if (frame === keepAlive) {
            yield keepAliveFrame;
            continue;
          }
          const encoded = dialect.encode(frame);
          if (encoded.end === 'protocol-error') outcome = failedRender('protocol-error');
          reachedTerminal = encoded.end !== undefined;
          if (encoded.wire !== null) yield Bytes.fromUtf8(encoded.wire);
          if (reachedTerminal) return;
        }
        if (!scope.signal.aborted) {
          const error = new Error(dialect.eofMessage);
          outcome = failedRender('premature-eof', error);
          yield failureFrame(error);
        }
      } catch (error) {
        if (!scope.signal.aborted && error instanceof UpstreamStreamProtocolError) {
          outcome = failedRender('protocol-error', error);
          yield failureFrame(error);
          return;
        }
        if (interruption === undefined || error !== interruption.error) throw error;
        outcome = { kind: 'failed', reason: 'source-error', error: interruption.failure.error };
        yield failureFrame(error);
      }
    },
    onClose(end) {
      if (end.how === 'errored') outcome = failedRender('source-error', end.error);
      else if (end.how === 'leaked') outcome = failedRender('source-error');
      else if ((end.how === 'cancelled' || end.how === 'released') && !reachedTerminal && outcome.kind === 'completed') outcome = { kind: 'cancelled' };
      render.resolve(outcome);
      const disposition = outcome.kind === 'failed' ? 'stream-error' : reachedTerminal ? 'completed' : end.how === 'cancelled' ? 'cancelled' : 'released';
      const usage = dialect.usage();
      billing.resolve(billableCall(scope, identity, disposition, usage));
      performance.resolve(streamPerformance(end, outcome.kind === 'failed', reachedTerminal, {
        firstOutputAt: null, streamEndedAt: scope.clock(), upstreamStartedAt: http.timing.startedAt, outputTokens: usage.usage?.output ?? 0,
      }));
    },
  });
  const billing = scope.deferred<BillableCall | null>('call.usage', stream);
  const render = scope.deferred<RenderOutcome>('render outcome', stream);
  const performance = scope.deferred<ObservedCallPerformance | null>('call.performance', stream);
  const headers = forwarded.headers.filter(([name]) => !['content-type', 'cache-control'].includes(name.toLowerCase()));
  return {
    'response.http': { ...forwarded, headers: [...headers, ['content-type', 'text/event-stream'], ['cache-control', 'no-cache'], ['connection', 'keep-alive']], body: stream },
    'response.render': render.deferred,
    'response.call.usage': billing.deferred,
    'response.call.performance': performance.deferred,
  };
};
