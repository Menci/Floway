import { readProtocolFrames } from './protocol-frames.ts';
import { chatBodyEntry, chatBodyExit, type ChatProtocol, type ChatRequestKey, type ChatResponseKey } from './topology.ts';
import { gatewayFactSpace, type GatewayPipelineFacts } from '../../pipeline/facts.ts';
import type { ProtocolEvent } from '../../pipeline/protocol-outcome.ts';
import { responseHead } from '../../pipeline/response.ts';
import type { GatewayServices } from '../../pipeline/services.ts';
import { SidecarDomain } from '../shared/sidecar-codec.ts';
import { deleteHeader, materializeHeaders, setHeader, type HttpResponseFact } from '@floway-dev/http';
import { move, type ManagedStream, type Pipeline, type Result } from '@floway-dev/pipeline';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ProtocolError, ProtocolStreamError, ProviderOperationFacts } from '@floway-dev/provider';
import type { TranslateInputError, TranslateTrip, Translator } from '@floway-dev/translate';

type ChatPayload<Protocol extends ChatProtocol> = {
  readonly [Key in ChatProtocol]: ProviderOperationFacts<Key>[ChatRequestKey<Key>];
}[Protocol];
type ChatEvent<Protocol extends ChatProtocol> = ProtocolEvent<ChatResponseKey<Protocol>>;
type StreamingRequest<Protocol extends ChatProtocol> = ChatPayload<Protocol> & { readonly stream: true; readonly model: string };
type ChatBody<Protocol extends ChatProtocol> = Pipeline<
  never,
  Pick<GatewayPipelineFacts, 'response.http' | ChatResponseKey<Protocol>>,
  GatewayServices
>;

const { compose, defineStage } = gatewayFactSpace<GatewayServices>();

const translateFrames = async function* <In, Out>(
  items: AsyncIterable<Result<In, ProtocolStreamError>>,
  translate: (frames: AsyncIterable<ProtocolFrame<In>>) => AsyncIterable<ProtocolFrame<Out>>,
  abort: () => void,
): AsyncGenerator<Result<Out, ProtocolStreamError>> {
  const source = readProtocolFrames(items);
  let failure: ProtocolStreamError | undefined;
  try {
    for await (const frame of translate(source.frames())) {
      if (frame.type === 'done') break;
      yield { ok: true, value: frame.event };
    }
    failure = source.failure;
  } catch (cause) {
    const upstream = source.failure;
    failure = upstream !== undefined && cause === upstream ? upstream : { kind: 'protocol', cause };
  }
  if (!source.done) abort();
  if (failure !== undefined) yield { ok: false, error: failure };
  await source.drain();
};

const encode = new TextEncoder();

const restateError = (
  outcome: ProtocolError,
  http: HttpResponseFact | null,
  translate: TranslateTrip<unknown, never, never>['error'],
) => {
  const body = JSON.stringify(outcome.error);
  if (body === undefined) throw new TypeError('Expected a JSON-serializable protocol error');
  const headers = http === null ? new Headers() : new Headers(materializeHeaders(http.headers));
  const translated = translate(http?.status ?? 502, headers, encode.encode(body));
  if (translated === undefined) return { http, outcome };

  const contentType = translated.headers.get('content-type');
  if (contentType === null) throw new TypeError('A restated protocol error needs a content type');
  const response = http === null ? null : {
    ...http,
    headers: setHeader(deleteHeader(deleteHeader(http.headers, 'content-length'), 'content-encoding'), 'content-type', contentType),
  };
  return { http: response, outcome: { ...outcome, error: translated.body } };
};

export const translateChat = <
  const Source extends ChatProtocol,
  const Target extends Exclude<ChatProtocol, NoInfer<Source>>,
>(source: Source, target: Target, translate: Translator<
  StreamingRequest<NoInfer<Source>>, ChatEvent<NoInfer<Source>>,
  ChatPayload<NoInfer<Target>>, ChatEvent<NoInfer<Target>>
>, targetBody: () => ChatBody<NoInfer<Target>>, formatInputError: (error: TranslateInputError) => unknown) => {
  const sourceRequestKey: ChatRequestKey<Source> = `request.${source}`;
  const targetRequestKey: ChatRequestKey<Target> = `request.${target}`;
  const sourceResponseKey: ChatResponseKey<Source> = `response.${source}`;
  const targetResponseKey: ChatResponseKey<Target> = `response.${target}`;
  const entry = chatBodyEntry(source);
  const exit = chatBodyExit(source);
  const crossesAnthropicMessages = source === 'anthropicMessages' || target === 'anthropicMessages';
  const generatesOpenAIResponses = target === 'openaiResponses';
  const request = { needs: entry } as const;
  const into = {
    target: {
      request: {
        needs: entry,
        provides: [
          targetRequestKey,
          ...(crossesAnthropicMessages ? ['request.http'] as const : []),
          ...(generatesOpenAIResponses ? ['request.openaiResponsesAction'] as const : []),
        ],
        consumes: [sourceRequestKey],
      },
      response: { needs: chatBodyExit(target), provides: ['response.http', sourceResponseKey], consumes: [targetResponseKey] },
    },
  } as const;
  const earlyReturn = { provides: exit } as const;
  const defineTranslation = defineStage<typeof request, typeof into, typeof earlyReturn>;
  type Answer = Awaited<ReturnType<Parameters<typeof defineTranslation>[0]['execute']>>;
  const name = `${source}.translate-via-${target}`;
  const ending = defineTranslation({
    name,
    request,
    into,
    return: earlyReturn,
    async execute(facts, scope) {
      const { [sourceRequestKey]: payload, ...forward } = facts;
      const { model } = facts['serve.candidate'];
      const trip = await translate({ ...payload, model: model.id, stream: true } as StreamingRequest<Source>, {
        sidecarCodec: scope.services.sidecarCodecFactory.codecFor(SidecarDomain.TranslatedAssistantTurn),
        ...(source === 'geminiGenerateContent' || target === 'anthropicMessages'
          ? { fallbackMaxOutputTokens: model.limits.max_output_tokens }
          : {}),
      });
      if (trip.type === 'input-error') return {
        'response.http': move(responseHead(400)),
        [sourceResponseKey]: move({ kind: 'error', source: 'local', error: formatInputError(trip) } as const),
      } as Answer;

      const requestHttp = facts['request.http'];
      const handoff = {
        ...forward,
        // Client-selected Anthropic betas apply only to native requests.
        // https://platform.claude.com/docs/en/api/beta-headers
        ...(crossesAnthropicMessages && {
          'request.http': move({ ...requestHttp, headers: deleteHeader(requestHttp.headers, 'anthropic-beta') }),
        }),
        ...(generatesOpenAIResponses && { 'request.openaiResponsesAction': 'generate' as const }),
        [targetRequestKey]: move(trip.target),
      };
      const call = scope.into.target(handoff as Parameters<typeof scope.into.target>[0]);
      const back = await call as Pick<GatewayPipelineFacts, 'response.http' | ChatResponseKey<Target>>;
      const { 'response.http': http, [targetResponseKey]: outcome, ...response } = back;
      if (outcome.kind === 'error') {
        const restated = restateError(outcome, http, trip.error);
        return {
          ...response,
          'response.http': move(restated.http),
          [sourceResponseKey]: move(restated.outcome),
        } as Answer;
      }
      if (outcome.kind === 'result') throw new TypeError(`The ${target} translation target returned a scalar result`);
      const stream = scope.wrapStream(
        outcome.stream as ManagedStream<ChatEvent<Target>, ProtocolStreamError>,
        (items, producer) => translateFrames(items, trip.events, () => { producer.abort(call); }),
      );
      return { ...response, 'response.http': http, [sourceResponseKey]: move({ kind: 'stream', stream } as const) } as Answer;
    },
  });
  return compose(name, { entry, exit, stages: [], ending, targets: { target: targetBody } });
};
