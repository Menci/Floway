import { gatewayFactSpace, type ClientDelivery, type GatewayPipelineFacts, type ProtocolResponseKey } from './facts.ts';
import { jsonResponseBody, responseHead } from './response.ts';
import { isForwardableUpstreamHeader } from '../shared/upstream-response.ts';
import { filterHeaders, isHttpBodyStream, type HttpResponseFact, type HttpStreamError } from '@floway-dev/http';
import { move, type ManagedStream, type Result } from '@floway-dev/pipeline';

const { defineStage } = gatewayFactSpace<{}>();

interface EncoderProducer {
  readonly signal: AbortSignal;
  readonly abort: () => void;
}

export interface EncoderScope extends EncoderProducer {
  readonly wrapStream: <T, E>(
    stream: ManagedStream<T, E>,
    produce: (source: AsyncIterable<Result<T, E>>, scope: EncoderProducer) => AsyncIterable<Result<Uint8Array, HttpStreamError>>,
  ) => ManagedStream<Uint8Array, HttpStreamError>;
}

type Success<Key extends ProtocolResponseKey> = Exclude<GatewayPipelineFacts[Key], { readonly kind: 'error' }>;

export type ProtocolRenderer<Key extends ProtocolResponseKey> = (
  outcome: Success<Key>,
  http: HttpResponseFact,
  delivery: ClientDelivery,
  scope: EncoderScope,
) => HttpResponseFact | Promise<HttpResponseFact>;

export const renderJsonResult = (outcome: { readonly kind: 'result'; readonly result: unknown }, http: HttpResponseFact): HttpResponseFact =>
  jsonResponseBody(http, outcome.result);

export const encodeResponse = <const Key extends ProtocolResponseKey>(responseKey: Key, render: ProtocolRenderer<Key>) => {
  const through = {
    request: { needs: ['request.delivery'], provides: [], consumes: [] },
    response: { needs: ['response.http', responseKey], provides: ['response.http'], consumes: [responseKey] },
  } as const;
  const defineEncoder = defineStage<typeof through>;
  type EncodedAnswer = Awaited<ReturnType<Parameters<typeof defineEncoder>[0]['execute']>>;
  return defineEncoder({
    name: 'serve.encode-response',
    through,
    async execute(facts, scope) {
      const call = scope.next(facts);
      const { [responseKey]: value, 'response.http': http, ...response } = await call;
      const outcome = value as GatewayPipelineFacts[Key];
      const head = http === null ? null : {
        ...http,
        headers: filterHeaders(http.headers, name => name === 'content-type' || isForwardableUpstreamHeader(name)),
        body: null,
      };

      const abort = (): void => { scope.abort(call); };
      if (http !== null && isHttpBodyStream(http.body)) {
        if (outcome.kind === 'stream') throw new TypeError('A protocol stream requires an empty HTTP body');
        abort();
        for await (const _ of http.body) {
          // The protocol result replaces this branch's HTTP body.
        }
      }

      const renderOutcome = async (): Promise<HttpResponseFact> => {
        if (outcome.kind === 'error') return jsonResponseBody(head ?? responseHead(502), outcome.error);
        if (head === null) throw new TypeError('A protocol success requires an HTTP response head');

        return await render(outcome as Success<Key>, head, facts['request.delivery'], {
          signal: scope.signal,
          abort,
          wrapStream: (stream, produce) => scope.wrapStream(stream, (source, producer) => produce(source, {
            signal: producer.signal,
            abort: () => { producer.abort(call); },
          })),
        });
      };
      return { ...response, 'response.http': move(await renderOutcome()) } as EncodedAnswer;
    },
  });
};
