import { gatewayFactSpace, type ClientDelivery, type GatewayPipelineFacts, type ProtocolResponseKey } from './facts.ts';
import { isHttpStreamError } from './protocol-outcome.ts';
import { jsonResponseBody, responseHead } from './response.ts';
import { isForwardableUpstreamHeader } from '../shared/upstream-response.ts';
import { filterHeaders, type HttpResponseFact, type HttpStreamError } from '@floway-dev/http';
import { move, type ManagedStream, type Result } from '@floway-dev/pipeline';
import { toInternalDebugError, type ProtocolError } from '@floway-dev/provider';

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

const renderTransportError = (outcome: ProtocolError): HttpResponseFact => {
  const head = responseHead(502, 'Bad Gateway');
  const { cause } = outcome;
  return jsonResponseBody(head, outcome.source === 'upstream' && isHttpStreamError(cause)
    ? { error: toInternalDebugError(cause.cause) }
    : outcome.error);
};

export const encodeResponse = <const Key extends ProtocolResponseKey>(
  responseKey: Key,
  render: ProtocolRenderer<Key>,
  renderWithoutHttp: (outcome: ProtocolError) => HttpResponseFact = renderTransportError,
) => {
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

      const renderOutcome = async (): Promise<HttpResponseFact> => {
        if (outcome.kind === 'error') return head === null ? renderWithoutHttp(outcome) : jsonResponseBody(head, outcome.error);
        if (head === null) throw new TypeError('A protocol success requires an HTTP response head');

        return await render(outcome as Success<Key>, head, facts['request.delivery'], {
          signal: scope.signal,
          abort: () => { scope.abort(call); },
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
