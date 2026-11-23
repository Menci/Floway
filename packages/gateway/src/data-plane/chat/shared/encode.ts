import { removeFact } from './remove-fact.ts';
import type { ChatEvent, ChatOutcomeFacts, ChatResult } from './route-body.ts';
import type { HttpOutput } from '../../pipeline/edge-http.ts';
import { forwardHttp } from '../../pipeline/non-chat.ts';
import { failedRender, renderedNow, type RenderFacts, type RenderOutcome } from '../../pipeline/render.ts';
import { openaiInternalErrorPayload } from '../../shared/openai-error-payload.ts';
import { DOWNSTREAM_KEEP_ALIVE_INTERVAL_MS, serializeSseFrame, type SseProtocol } from '../../shared/sse.ts';
import { type HeaderEntry, type HttpResponseFacts, isTransportFailure } from '@floway-dev/http';
import { Bytes, type Deferred, defineStage, type ErrorSnapshot, type ManagedStream, type Scope } from '@floway-dev/pipeline';
import { type ProtocolFrame, sseCommentFrame, type SseWritableFrame } from '@floway-dev/protocols/common';
import { type ChatTargetApi, type ProviderFrame, toInternalDebugError } from '@floway-dev/provider';

export interface DeliveryIntent { readonly stream: boolean }
export interface DeliveryFacts<Delivery extends DeliveryIntent = DeliveryIntent> {
  readonly 'request.delivery': Delivery;
}

interface SseKeepAlive {
  readonly intervalMs?: number;
  readonly frame: SseWritableFrame;
}

type FrameRead<T> = { readonly kind: 'frame'; readonly result: IteratorResult<T> }
  | { readonly kind: 'error'; readonly error: unknown };

export const transportErrorForDisplay = ({ name, message, stack, cause }: ErrorSnapshot): Error =>
  Object.assign(new Error(message, { cause }), { name, stack });

const encodeSse = <Event>(
  scope: Pick<Scope, 'defer' | 'wrapStream'>,
  events: ManagedStream<ProviderFrame<Event>>, protocol: SseProtocol<ProtocolFrame<Event>>, keepAlive: SseKeepAlive, completion: Deferred<boolean> | undefined,
) => {
  const interval = keepAlive.intervalMs ?? DOWNSTREAM_KEEP_ALIVE_INTERVAL_MS;
  if (!Number.isFinite(interval) || interval <= 0) throw new RangeError('SSE keepalive interval must be a positive number');
  const heartbeat = Bytes.fromUtf8(serializeSseFrame(keepAlive.frame));
  let outcome: RenderOutcome | undefined;
  const render = Promise.withResolvers<RenderOutcome>();
  const body = scope.wrapStream(events, {
    label: 'downstream SSE frames',
    async *transform(source, scope) {
      const { signal } = scope;
      const iterator = source[Symbol.asyncIterator]();
      let wake: (() => void) | undefined;
      const read = () => {
        let next: FrameRead<ProviderFrame<Event>> | undefined;
        const ready = (value: FrameRead<ProviderFrame<Event>>) => {
          next = value;
          wake?.();
        };
        void Promise.resolve().then(() => iterator.next()).then(
          result => ready({ kind: 'frame', result }),
          (error: unknown) => ready({ kind: 'error', error }),
        );
        return () => next;
      };
      const wait = () => new Promise<void>(resolve => {
        const timer = setTimeout(resolve, interval);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      const onAbort = () => wake?.();
      signal.addEventListener('abort', onAbort);
      type Encoded = ReturnType<typeof protocol.encode>;
      const failure = (error: unknown, reason: 'source-error' | 'premature-eof'): Encoded => {
        outcome = failedRender(reason, error);
        try {
          return { wire: null, end: { type: 'protocol-error', trailer: protocol.failure(error) } };
        } catch (renderError) {
          throw new AggregateError([error, renderError], 'Failed to encode the SSE failure', { cause: error });
        }
      };
      try {
        while (!signal.aborted) {
          const current = read();
          let next = current();
          while (next === undefined && !signal.aborted) {
            await wait();
            wake = undefined;
            next = current();
            if (next === undefined && !signal.aborted) yield heartbeat;
            next = current();
          }
          if (next === undefined || signal.aborted) return;
          if (next.kind === 'error') throw next.error;
          let encoded: Encoded;
          if (next.result.done) {
            const contentComplete = completion === undefined ? undefined : await completion.promise;
            encoded = { wire: null, end: protocol.eof(contentComplete) };
          } else if (isTransportFailure(next.result.value)) {
            const snapshot = next.result.value.error;
            encoded = failure(transportErrorForDisplay(snapshot), 'source-error');
            outcome = { kind: 'failed', reason: 'source-error', error: snapshot };
          } else {
            encoded = protocol.encode(next.result.value);
          }
          if (encoded.end?.type === 'premature-eof') encoded = failure(encoded.end.error, 'premature-eof');
          const end = encoded.end;
          if (end?.type === 'completed') outcome = { kind: 'completed' };
          if (end?.type === 'protocol-error') outcome ??= failedRender('protocol-error');
          if (encoded.wire !== null) yield Bytes.fromUtf8(encoded.wire);
          if (end !== undefined) {
            if (end.type !== 'premature-eof') {
              for (const trailer of end.trailer ?? []) yield Bytes.fromUtf8(trailer);
            }
            return;
          }
        }
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    },
    onClose: end => {
      if (end.how === 'errored' || end.how === 'leaked') {
        render.resolve(failedRender('source-error', end.how === 'errored' ? end.error : undefined));
      } else if (outcome !== undefined) {
        render.resolve(outcome);
      } else if (end.how === 'cancelled' || end.how === 'released') {
        // The source observation can settle after this wrapper releases it.
        render.resolve(completion === undefined ? { kind: 'cancelled' } : completion.promise.then(
          (complete): RenderOutcome => ({ kind: complete ? 'completed' : 'cancelled' }),
        ));
      } else {
        render.resolve(failedRender('source-error'));
      }
    },
  });
  return { body, 'response.render': scope.defer('render outcome', render.promise) };
};

const responseHeaders = (http: HttpResponseFacts, contentType: string, base: readonly HeaderEntry[] = []): HeaderEntry[] => {
  const overridden = new Set(['content-type', ...base.map(([name]) => name)]);
  const forwarded = forwardHttp(http, null).headers.filter(([name]) => !overridden.has(name.toLowerCase()));
  return [...forwarded, ...base, ['content-type', contentType]];
};

interface RenderedFailure {
  readonly status: number;
  readonly body: unknown;
  readonly reason?: 'protocol-error' | 'collect-error';
}

const defaultFailure = (error: unknown): RenderedFailure => ({ status: 502, body: openaiInternalErrorPayload(toInternalDebugError(error)) });

const jsonBody = (http: HttpResponseFacts, value: unknown, status = http.status): HttpResponseFacts => ({
  ...http,
  status,
  statusText: status === http.status ? http.statusText : '',
  headers: responseHeaders(http, 'application/json'),
  body: Bytes.fromUtf8(JSON.stringify(value)),
});

export const createEncode = <Api extends ChatTargetApi, Delivery extends DeliveryIntent = DeliveryIntent, Event = ChatEvent<Api>,
  ExtraResponse extends object = {}, Result = ChatResult<Api>>(
  api: Api,
  dialect: {
    readonly encodeJson: (source: AsyncIterable<ProtocolFrame<Event>>, delivery: Delivery) => Promise<unknown>;
    readonly openSse?: (delivery: Delivery) => SseProtocol<ProtocolFrame<Event>>;
    readonly keepAlive?: SseKeepAlive;
    readonly collectFailure?: (error: unknown) => RenderedFailure;
    readonly transportError?: (error: unknown) => RenderedFailure;
    readonly jsonOutcome?: (json: unknown) => RenderOutcome;
    readonly encodeScalar?: (result: Result, delivery: Delivery) => unknown | Promise<unknown>;
    readonly contentCompletion?: {
      readonly needs: readonly (keyof ExtraResponse & string)[];
      readonly read: (response: ExtraResponse) => Deferred<boolean> | undefined;
    };
  },
) => {
  type Request = DeliveryFacts<Delivery>;
  type Response = HttpOutput & ExtraResponse & ChatOutcomeFacts<Api, Event, Result>;
  const responseKey = `response.${api}` as const;
  const completionKeys = dialect.contentCompletion?.needs ?? [];
  return defineStage<Request, Request, Response, HttpOutput & RenderFacts>({
    name: 'encode',
    through: {
      request: { needs: ['request.delivery'], consumes: [], provides: [] },
      response: {
        needs: ['response.http', responseKey, ...completionKeys],
        consumes: [responseKey, ...completionKeys],
        provides: ['response.http', 'response.render'],
      },
    },
    execute: async (facts, scope) => {
      const delivery = facts['request.delivery'];
      const returned = await scope.next(facts);
      const outcome = returned[responseKey];
      const completion = dialect.contentCompletion?.read(returned);
      const response = removeFact<HttpOutput & ExtraResponse, typeof responseKey>(returned, responseKey);
      for (const key of completionKeys) delete response[key];
      const http = response['response.http'];
      if (outcome.kind === 'error') {
        const failure = http.transportError === undefined
          ? { status: http.status, body: outcome.error }
          : (dialect.transportError ?? defaultFailure)(transportErrorForDisplay(http.transportError));
        return { ...response, 'response.http': jsonBody(http, failure.body, failure.status), ...renderedNow(scope, { kind: 'completed' }) };
      }
      if (outcome.kind === 'result') {
        const value = dialect.encodeScalar === undefined ? outcome.result : await dialect.encodeScalar(outcome.result, delivery);
        return { ...response, 'response.http': jsonBody(http, value), ...renderedNow(scope, { kind: 'completed' }) };
      }
      if (delivery.stream) {
        if (dialect.openSse === undefined) throw new TypeError(`The ${api} encoder does not support SSE delivery`);
        const { body, 'response.render': render } = encodeSse(
          scope, outcome.events, dialect.openSse(delivery), dialect.keepAlive ?? { frame: sseCommentFrame('keepalive') }, completion,
        );
        return {
          ...response,
          'response.http': {
            ...http, body,
            headers: responseHeaders(http, 'text/event-stream', [['cache-control', 'no-cache'], ['connection', 'keep-alive'], ['transfer-encoding', 'chunked']]),
          },
          'response.render': render,
        };
      }

      let transport: ErrorSnapshot | undefined;
      let panic: { readonly error: unknown } | undefined;
      const frames = async function* () {
        const iterator = outcome.events[Symbol.asyncIterator]();
        try {
          for (;;) {
            const next = await iterator.next().catch((error: unknown) => {
              panic = { error };
              throw error;
            });
            if (next.done) return;
            if (isTransportFailure(next.value)) {
              transport = next.value.error;
              throw transportErrorForDisplay(transport);
            }
            yield next.value;
          }
        } finally {
          await iterator.return?.();
        }
      };
      let json: unknown;
      try {
        json = await dialect.encodeJson(frames(), delivery);
      } catch (error) {
        if (panic !== undefined) throw panic.error;
        const failure = (dialect.collectFailure ?? defaultFailure)(error);
        return {
          ...response,
          'response.http': jsonBody(http, failure.body, failure.status),
          ...renderedNow(scope, transport === undefined
            ? failedRender(failure.reason ?? 'collect-error', error)
            : { kind: 'failed', reason: 'collect-error', error: transport }),
        };
      }
      return {
        ...response,
        'response.http': jsonBody(http, json),
        ...renderedNow(scope, dialect.jsonOutcome?.(json) ?? { kind: 'completed' }),
      };
    },
  });
};
