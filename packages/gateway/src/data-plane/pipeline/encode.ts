import { defineOperationStage, type GatewayPipelineFacts, type ResponseOutcome } from './facts.ts';
import { filterHeaders, getHeader, setHeader, type HttpBodyError, type HttpResponseFact } from '@floway-dev/http';
import type { Facts, ManagedStream, Result } from '@floway-dev/pipeline';
import { isJsonMediaType } from '@floway-dev/protocols/common';
import type { ProtocolError, ProtocolStreamError, ProviderOperation } from '@floway-dev/provider';

type ResponseHead = Omit<HttpResponseFact, 'body'>;
type ByteStream = ManagedStream<Uint8Array, HttpBodyError>;
type Bytes = AsyncGenerator<Result<Uint8Array, HttpBodyError>, void, unknown>;
type ObservedOutcome = ProtocolError | { kind: 'result' } | { kind: 'stream'; stream: ManagedStream<unknown, ProtocolStreamError> };

interface Reader {
  read<Event, Error>(source: ManagedStream<Event, Error>): AsyncIterableIterator<Result<Event, Error>>;
  discard(source: ManagedStream<unknown, unknown>): void;
}

export interface EncoderScope extends Reader {
  wrapStream<Event>(
    source: ManagedStream<Event, ProtocolStreamError>,
    encode: (source: ManagedStream<Event, ProtocolStreamError>, producer: Reader) => Bytes,
  ): ByteStream;
}

interface EncoderInput<Op extends ProviderOperation, Delivery> {
  delivery: Delivery;
  http: ResponseHead | null;
  outcome: GatewayPipelineFacts[`response.${Op}`];
}

type RequestEncoderInput<Op extends ProviderOperation, Delivery> = EncoderInput<Op, Delivery> & {
  request: GatewayPipelineFacts[`request.${Op}`];
};
type EncodingStage = ReturnType<typeof defineOperationStage>;

interface Encode {
  <Op extends ProviderOperation, Delivery = undefined>(
    operation: Op,
    render: (input: EncoderInput<Op, Delivery>, scope: EncoderScope) => HttpResponseFact | Promise<HttpResponseFact>,
    ...delivery: Delivery extends undefined ? [] : ['request.delivery']
  ): EncodingStage;
  <Op extends ProviderOperation>(
    operation: Op,
    render: (input: RequestEncoderInput<Op, undefined>, scope: EncoderScope) => HttpResponseFact | Promise<HttpResponseFact>,
    need: 'request',
  ): EncodingStage;
}

const chat = new Set<ProviderOperation>(['openaiChatCompletions', 'openaiResponses', 'anthropicMessages', 'geminiGenerateContent']);

export const encode: Encode = <Op extends ProviderOperation, Delivery>(
  operation: Op,
  render: (input: RequestEncoderInput<Op, Delivery>, scope: EncoderScope) => HttpResponseFact | Promise<HttpResponseFact>,
  need?: 'request' | 'request.delivery',
) => {
  const outcome: `response.${ProviderOperation}` = `response.${operation}`;
  const payload = `request.${operation}` as const;
  const responseNeeds: readonly string[] = ['response.http', outcome];
  const requestNeeds: readonly string[] = need === 'request' ? [payload] : need === 'request.delivery' ? [need] : [];
  return defineOperationStage({
    name: `${operation}.encode`,
    through: {
      request: { needs: requestNeeds, provides: [], consumes: [] },
      response: { needs: responseNeeds, provides: ['response.http', 'response.outcome'], consumes: [outcome] },
    },
    async execute(facts, scope) {
      const { [outcome]: value, 'response.http': response, ...answer }: Facts = await scope.next(facts);
      const http = response as HttpResponseFact | null;
      const parsed = value as ObservedOutcome;
      if (http?.body && !(http.body instanceof Uint8Array)) scope.discard(http.body);
      const damaged = !chat.has(operation) && parsed.kind === 'error' && parsed.source === 'upstream'
        && http !== null && http.status >= 200 && http.status < 300;
      const observed = Promise.withResolvers<ResponseOutcome>();
      const responseOutcome = scope.createDeferred(() => observed.promise);
      let rendered: ObservedOutcome = parsed;
      if (parsed.kind === 'stream') {
        const stream = scope.wrapStream(parsed.stream, async function* (inner, producer) {
          try {
            for await (const item of producer.read(inner)) {
              if (!item.ok) {
                observed.resolve(item.error.kind === 'abort' ? 'local' : 'upstream');
                producer.discard(inner);
                yield item;
                return;
              }
              yield item;
            }
            observed.resolve('success');
          } catch (error) {
            observed.reject(error);
            throw error;
          }
        });
        rendered = { kind: 'stream', stream };
      } else {
        observed.resolve(parsed.kind === 'error' ? parsed.source : 'success');
      }
      return {
        ...answer,
        'response.outcome': responseOutcome,
        'response.http': await render({
          delivery: (need === 'request.delivery' ? facts['request.delivery'] : undefined) as Delivery,
          http: damaged ? { ...http, status: 502, statusText: '' } : http,
          outcome: rendered as EncoderInput<Op, Delivery>['outcome'],
          request: (need === 'request' ? facts[payload] : undefined) as RequestEncoderInput<Op, Delivery>['request'],
        }, scope),
      };
    },
  });
};

const rewrittenBodyHeaders = new Set(['content-length', 'content-encoding']);

export const encodedResponse = (
  head: ResponseHead,
  body: HttpResponseFact['body'],
  contentType?: string,
): HttpResponseFact => {
  const headers = filterHeaders(head.headers, name => !rewrittenBodyHeaders.has(name));
  // Fetch forbids a body on these status codes.
  const noBody = head.status === 204 || head.status === 205 || head.status === 304;
  return {
    ...head,
    headers: contentType === undefined ? headers : setHeader(headers, 'content-type', contentType),
    body: noBody ? null : body,
  };
};

export const jsonResponse = (head: ResponseHead, value: unknown): HttpResponseFact => {
  const mediaType = getHeader(head.headers, 'content-type');
  return encodedResponse(head, new TextEncoder().encode(JSON.stringify(value)),
    typeof mediaType === 'string' && isJsonMediaType(mediaType) ? undefined : 'application/json');
};

export const localResponseHead = (status: number): ResponseHead => ({ status, statusText: '', headers: [] });

export const encodeStream = <Event>(
  source: ManagedStream<Event, ProtocolStreamError>,
  scope: EncoderScope,
  render: (item: Result<Event, ProtocolStreamError>) => Iterable<Uint8Array>,
  onDone: () => Iterable<Uint8Array> = () => [],
): ByteStream => scope.wrapStream(source, async function* (inner, producer) {
  for await (const item of producer.read(inner)) {
    if (!item.ok) producer.discard(inner);
    for (const bytes of render(item)) yield { ok: true, value: bytes };
    if (!item.ok) return;
  }
  for (const bytes of onDone()) yield { ok: true, value: bytes };
});
