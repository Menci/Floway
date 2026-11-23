import { removeFact } from './remove-fact.ts';
import type { ChatEvent, ChatFrameFacts } from './route-body.ts';
import type { AttemptResponse } from '../../pipeline/failover.ts';
import { forwardHttp } from '../../pipeline/non-chat.ts';
import { failedRender, renderedNow, type RenderFacts, type RenderOutcome } from '../../pipeline/render.ts';
import type { GatewayServices } from '../../pipeline/services.ts';
import { openaiInternalErrorPayload } from '../../shared/openai-error-payload.ts';
import { DOWNSTREAM_KEEP_ALIVE_INTERVAL_MS, serializeSseFrame, type SseProtocol } from '../../shared/sse.ts';
import type { HeaderEntry, HttpResponseFacts } from '@floway-dev/http';
import { Bytes, defineStage, type ManagedStream, type StageEnv } from '@floway-dev/pipeline';
import { type ProtocolFrame, sseCommentFrame, type SseWritableFrame } from '@floway-dev/protocols/common';
import { type ChatTargetApi, toInternalDebugError } from '@floway-dev/provider';

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

const encodeSse = <T>(env: StageEnv<GatewayServices>, events: ManagedStream<T>, protocol: SseProtocol<T>, keepAlive: SseKeepAlive) => {
  const interval = keepAlive.intervalMs ?? DOWNSTREAM_KEEP_ALIVE_INTERVAL_MS;
  if (!Number.isFinite(interval) || interval <= 0) throw new RangeError('SSE keepalive interval must be a positive number');
  const heartbeat = Bytes.fromUtf8(serializeSseFrame(keepAlive.frame));
  let outcome: RenderOutcome | undefined;
  const body = env.wrapStream(events, {
    label: 'downstream SSE frames',
    async *transform(source, signal) {
      const iterator = source[Symbol.asyncIterator]();
      let wake: (() => void) | undefined;
      const read = () => {
        let next: FrameRead<T> | undefined;
        const ready = (value: FrameRead<T>) => {
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
          let encoded: Encoded;
          try {
            if (next.kind === 'error') encoded = failure(next.error, 'source-error');
            else if (next.result.done) encoded = { wire: null, end: protocol.eof() };
            else encoded = protocol.encode(next.result.value);
          } catch (error) {
            if (outcome !== undefined) throw error;
            encoded = failure(error, 'source-error');
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
      } else {
        render.resolve(outcome ?? failedRender('source-error'));
      }
    },
  });
  const render = env.deferred<RenderOutcome>('render outcome', body);
  return { body, 'response.render': render.deferred };
};

const responseHeaders = (http: HttpResponseFacts, contentType: string, base: readonly HeaderEntry[] = []): HeaderEntry[] => {
  const overridden = new Set(['content-type', ...base.map(([name]) => name)]);
  const forwarded = forwardHttp(http, null).headers.filter(([name]) => !overridden.has(name.toLowerCase()));
  return [...forwarded, ...base, ['content-type', contentType]];
};

export const createEncode = <Api extends ChatTargetApi, Delivery extends DeliveryIntent = DeliveryIntent, Event = ChatEvent<Api>,
  ExtraResponse extends object = {}>(
  api: Api,
  dialect: {
    readonly encodeJson: (source: AsyncIterable<ProtocolFrame<Event>>, delivery: Delivery, env: StageEnv<GatewayServices>) => Promise<unknown>;
    readonly openSse: (delivery: Delivery, env: StageEnv<GatewayServices>) => SseProtocol<ProtocolFrame<Event>>;
    readonly keepAlive?: SseKeepAlive;
    readonly collectFailure?: (error: unknown) => { readonly status: number; readonly body: unknown };
    readonly jsonOutcome?: (json: unknown) => RenderOutcome;
    readonly encodeScalar?: (response: AttemptResponse & ExtraResponse, delivery: Delivery, env: StageEnv<GatewayServices>) => Promise<HttpResponseFacts>;
  },
) => {
  type Request = DeliveryFacts<Delivery>;
  type Response = AttemptResponse & ExtraResponse & ChatFrameFacts<Api, Event>;
  const responseKey = `response.${api}` as const;
  return defineStage<Request, Request, Response, AttemptResponse & RenderFacts, GatewayServices>({
    name: 'encode',
    through: {
      request: { needs: ['request.delivery'], consumes: [], provides: [] },
      response: { needs: ['response.http', responseKey], consumes: [responseKey], provides: ['response.http', 'response.render'] },
    },
    execute: async (facts, next, env) => {
      const delivery = facts['request.delivery'];
      const returned = await next(facts);
      const frames = returned[responseKey];
      const response = removeFact<AttemptResponse & ExtraResponse, typeof responseKey>(returned, responseKey);
      const http = response['response.http'];
      if (frames === undefined) {
        const encoded = dialect.encodeScalar === undefined
          ? forwardHttp(http, null)
          : await dialect.encodeScalar(response, delivery, env);
        return { ...response, 'response.http': encoded, ...renderedNow(env, { kind: 'completed' }) };
      }
      if (delivery.stream) {
        const { body, 'response.render': render } = encodeSse(
          env, frames, dialect.openSse(delivery, env), dialect.keepAlive ?? { frame: sseCommentFrame('keepalive') },
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
      try {
        const json = await dialect.encodeJson(frames, delivery, env);
        return {
          ...response,
          'response.http': { ...http, headers: responseHeaders(http, 'application/json'), body: Bytes.fromUtf8(JSON.stringify(json)) },
          ...renderedNow(env, dialect.jsonOutcome?.(json) ?? { kind: 'completed' }),
        };
      } catch (error) {
        const failure = dialect.collectFailure?.(error) ?? { status: 502, body: openaiInternalErrorPayload(toInternalDebugError(error)) };
        return {
          ...response,
          'response.http': {
            ...http, status: failure.status, statusText: '', headers: [['content-type', 'application/json']],
            body: Bytes.fromUtf8(JSON.stringify(failure.body)),
          },
          ...renderedNow(env, failedRender('collect-error', error)),
        };
      }
    },
  });
};
