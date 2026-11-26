import { chatBodyEntry, chatBodyExit, chatEgressEntry, chatEgressExit, passthrough, type ChatOperation, type ChatOutcome, type ChatPayload } from './pipeline.ts';
import { SidecarDomain } from './sidecar-codec.ts';
import { defineOperationStage, type OperationEvent } from '../../pipeline/facts.ts';
import { openAIResponsesFailureEvents } from '../openai-responses/stream-error.ts';
import { deleteHeader, hasHeader, type HttpRequestFact, type HttpResponseFact } from '@floway-dev/http';
import type { ManagedStream, Result } from '@floway-dev/pipeline';
import { doneFrame, eventFrame, isJsonObject, type JsonObject, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { ProtocolError, ProtocolStreamError, ProviderModelFact } from '@floway-dev/provider';
import {
  routeAnthropicMessagesViaOpenAIChatCompletions,
  routeAnthropicMessagesViaOpenAIResponses,
  routeGeminiGenerateContentViaAnthropicMessages,
  routeGeminiGenerateContentViaOpenAIChatCompletions,
  routeGeminiGenerateContentViaOpenAIResponses,
  routeOpenAIChatCompletionsViaAnthropicMessages,
  routeOpenAIChatCompletionsViaOpenAIResponses,
  routeOpenAIResponsesViaAnthropicMessages,
  routeOpenAIResponsesViaOpenAIChatCompletions,
  type TranslateInputError,
  type TranslateTrip,
  type Translator,
} from '@floway-dev/translate';

export const chatTargets = {
  anthropicMessages: { openaiResponses: 'openaiResponses', openaiChatCompletions: 'openaiChatCompletions' },
  geminiGenerateContent: {
    openaiChatCompletions: 'openaiChatCompletions', anthropicMessages: 'anthropicMessages', openaiResponses: 'openaiResponses',
  },
  openaiChatCompletions: { anthropicMessages: 'anthropicMessages', openaiResponses: 'openaiResponses' },
  openaiResponses: { anthropicMessages: 'anthropicMessages', openaiChatCompletions: 'openaiChatCompletions' },
} as const;

export const pickChatTarget = (source: ChatOperation, endpoints: ProviderModelFact['endpoints']): ChatOperation | undefined => {
  if (endpoints[source] !== undefined) return source;
  return Object.values(chatTargets[source]).find(target => endpoints[target] !== undefined);
};

type TranslationInput<Op extends ChatOperation> = ChatPayload<Op> & { model: string; stream: true };
type Translation<Source extends ChatOperation, Target extends ChatOperation> =
  Translator<TranslationInput<Source>, OperationEvent<Source>, ChatPayload<Target>, OperationEvent<Target>>;

const translations = {
  anthropicMessages: {
    openaiResponses: routeAnthropicMessagesViaOpenAIResponses,
    openaiChatCompletions: routeAnthropicMessagesViaOpenAIChatCompletions,
  },
  geminiGenerateContent: {
    openaiChatCompletions: routeGeminiGenerateContentViaOpenAIChatCompletions,
    anthropicMessages: routeGeminiGenerateContentViaAnthropicMessages,
    openaiResponses: routeGeminiGenerateContentViaOpenAIResponses,
  },
  openaiChatCompletions: {
    anthropicMessages: routeOpenAIChatCompletionsViaAnthropicMessages,
    openaiResponses: routeOpenAIChatCompletionsViaOpenAIResponses,
  },
  openaiResponses: {
    anthropicMessages: routeOpenAIResponsesViaAnthropicMessages,
    openaiChatCompletions: routeOpenAIResponsesViaOpenAIChatCompletions,
  },
} satisfies {
  [Source in ChatOperation]: {
    [Target in keyof typeof chatTargets[Source] & ChatOperation]: Translation<Source, Target>;
  };
};

interface FrameReader {
  read<Event>(stream: ManagedStream<Event, ProtocolStreamError>): AsyncIterableIterator<Result<Event, ProtocolStreamError>>;
  discard(stream: ManagedStream<unknown, unknown>): void;
}

interface FrameScope {
  wrapStream<In, Out>(
    stream: ManagedStream<In, ProtocolStreamError>,
    transform: (inner: ManagedStream<In, ProtocolStreamError>, producer: FrameReader) => AsyncGenerator<Result<Out, ProtocolStreamError>, void, unknown>,
  ): ManagedStream<Out, ProtocolStreamError>;
}

const wrapFrames = <In, Out, ErrorFrame = never>(
  stream: ManagedStream<In, ProtocolStreamError>,
  scope: FrameScope,
  transform: (frames: AsyncIterable<ProtocolFrame<In> | ErrorFrame>) => AsyncIterable<ProtocolFrame<Out>>,
  error?: {
    input(error: ProtocolStreamError): { frame: ErrorFrame; contentFilter: boolean };
    output(error: ProtocolStreamError, event: Out | undefined): ProtocolStreamError;
  },
): ManagedStream<Out, ProtocolStreamError> => scope.wrapStream(stream, async function* (inner, producer) {
  const cursor = producer.read(inner);
  let held = true;
  let failure: ProtocolStreamError | undefined;
  let translatedError: Out | undefined;
  let contentFilter = false;
  let translatedContent = false;
  const input: AsyncIterable<ProtocolFrame<In> | ErrorFrame> = {
    [Symbol.asyncIterator]: () => ({
      async next() {
        if (!held) return { done: true, value: undefined };
        const item = await cursor.next();
        if (item.done) {
          held = false;
          return error === undefined ? { done: false, value: doneFrame() } : item;
        }
        if (item.value.ok) return { done: false, value: eventFrame(item.value.value) };
        failure = item.value.error;
        producer.discard(inner);
        held = false;
        if (error === undefined) return { done: true, value: undefined };
        const adapted = error.input(failure);
        contentFilter = adapted.contentFilter;
        return { done: false, value: adapted.frame };
      },
    }),
  };
  for await (const frame of transform(input)) {
    if (frame.type === 'done') continue;
    if (failure === undefined) {
      yield { ok: true, value: frame.event };
    } else if (error !== undefined) {
      if (contentFilter) {
        if (isFailureEvent(frame.event)) throw new TypeError('A translated Responses policy refusal must produce a content-filter finish');
        translatedContent = true;
        yield { ok: true, value: frame.event };
      } else {
        if (translatedError !== undefined) throw new Error('A translation emitted more than one terminal failure event');
        translatedError = frame.event;
      }
    }
  }
  if (held) producer.discard(inner);
  if (failure !== undefined && !translatedContent) {
    yield { ok: false, error: error === undefined ? failure : error.output(failure, translatedError) };
  }
});

export const wrapChatFrames = <In, Out>(
  stream: ManagedStream<In, ProtocolStreamError>,
  scope: FrameScope,
  transform: (frames: AsyncIterable<ProtocolFrame<In>>) => AsyncIterable<ProtocolFrame<Out>>,
): ManagedStream<Out, ProtocolStreamError> => wrapFrames(stream, scope, transform);

type TranslationFailure<Event> = { ok: false; error: unknown; event?: Event };

const isFailureEvent = (event: unknown): event is JsonObject =>
  isJsonObject(event) && ('error' in event || event.type === 'error' || event.type === 'response.failed');

const targetErrorEvent = (target: ChatOperation, error: ProtocolStreamError): { event?: unknown; contentFilter: boolean } => {
  if (error.kind !== 'protocol' || error.event === undefined) return { contentFilter: false };
  if (target === 'openaiResponses') {
    const { notification, failed } = openAIResponsesFailureEvents(error);
    const code = failed?.response.error?.code;
    if (failed !== undefined && (code === 'bio_policy' || code === 'cyber_policy')) return { event: failed, contentFilter: true };
    const event = notification ?? failed;
    if (event === undefined) throw new TypeError('Responses protocol failure must contain a notification or failed resource');
    return { event, contentFilter: false };
  }
  if (target === 'anthropicMessages') {
    const { type, error: nested, ...fields } = error.event;
    const details = isJsonObject(nested) ? nested : type === 'error' ? fields : error.event;
    const event = type === 'error' && isJsonObject(nested) ? error.event : { ...fields, type: 'error', error: details };
    return { event, contentFilter: false };
  }
  if (target === 'openaiChatCompletions' && !isJsonObject(error.event.error)) {
    return { event: { error: error.event }, contentFilter: false };
  }
  return { event: error.event, contentFilter: false };
};

export const translateChatFrames = <In, Out>(
  { source, target }: { source: ChatOperation; target: ChatOperation },
  stream: ManagedStream<In, ProtocolStreamError>,
  scope: FrameScope,
  transform: (frames: AsyncIterable<ProtocolFrame<In> | TranslationFailure<In>>) => AsyncIterable<ProtocolFrame<Out>>,
): ManagedStream<Out, ProtocolStreamError> => wrapFrames(stream, scope, transform, {
  input(error): { frame: TranslationFailure<In>; contentFilter: boolean } {
    const { event, contentFilter } = targetErrorEvent(target, error);
    return { frame: { ok: false, error: error.cause, ...(event === undefined ? {} : { event: event as In }) }, contentFilter };
  },
  output(error, event) {
    if (error.kind !== 'protocol' || error.event === undefined) return error;
    if (!isFailureEvent(event)) throw new TypeError('An upstream protocol error must translate to a source error event');
    const projected = source === 'openaiResponses'
      ? event.type === 'response.failed' ? { failed: event } : { notification: event }
      : event;
    return { ...error, event: projected };
  },
});

const errorBytes = new TextEncoder();

const translateHttpError = (outcome: ProtocolError, http: HttpResponseFact | null, translate: TranslateTrip<unknown, unknown, unknown>['error']): ProtocolError => {
  if (outcome.source !== 'upstream' || http === null) return outcome;

  const headers = new Headers();
  for (const [name, value] of http.headers) {
    if (typeof value !== 'string') throw new TypeError(`Secret upstream response header ${name} cannot be passed to a translator`);
    headers.append(name, value);
  }
  const translated = translate(http.status, headers, errorBytes.encode(JSON.stringify(outcome.error)));
  return translated === undefined ? outcome : { ...outcome, error: translated.body };
};

export const routeChatBody = <Source extends ChatOperation>(
  source: Source,
  invalid: (error: TranslateInputError) => { http: HttpResponseFact; outcome: ProtocolError },
) => {
  const sourcePayload: string = `request.${source}`;
  const sourceOutcome: string = `response.${source}`;
  const request: readonly string[] = chatBodyEntry(source);
  const targets = Object.values(chatTargets[source]);
  const into = Object.fromEntries(targets.map(target => [target, {
    request: {
      needs: request,
      provides: [`request.${target}`, ...target === 'anthropicMessages' ? ['request.http'] : []],
      consumes: [sourcePayload, ...source === 'geminiGenerateContent' ? ['request.model'] : []],
    },
    response: { needs: chatBodyExit(target), provides: [sourceOutcome], consumes: [`response.${target}`] },
  }]));

  return defineOperationStage({
    name: `${source}.route`,
    request: { needs: request },
    into: { ...into, native: passthrough(chatEgressEntry(source), chatEgressExit(source)) },
    return: { provides: ['response.http', sourceOutcome] },
    async execute(facts, scope) {
      const model = facts['provider.model'] as ProviderModelFact;
      const target = pickChatTarget(source, model.endpoints);
      if (target === source) return await scope.into.native(facts);
      if (target === undefined) throw new Error(`Model ${model.id} cannot serve ${source}`);
      const translate = (translations[source] as unknown as Record<ChatOperation, Translation<Source, ChatOperation>>)[target];
      const { [sourcePayload]: value, 'request.model': pathModel, ...request } = facts;
      const payload = value as ChatPayload<Source>;
      const trip = await translate({ ...payload, ...source === 'geminiGenerateContent' ? { model: pathModel } : {}, stream: true } as TranslationInput<Source>, {
        sidecarCodec: scope.services.sidecarCodec.codecFor(SidecarDomain.TranslatedAssistantTurn),
        fallbackMaxOutputTokens: model.limits.max_output_tokens,
      });
      if (trip.type === 'input-error') {
        const failure = invalid(trip);
        return { 'response.http': failure.http, [sourceOutcome]: failure.outcome };
      }

      const http = request['request.http'] as HttpRequestFact;
      const targetHttp = target === 'anthropicMessages' && hasHeader(http.headers, 'anthropic-beta')
        ? { ...http, headers: deleteHeader(http.headers, 'anthropic-beta') }
        : http;
      const enter = (scope.into as Readonly<Record<string, typeof scope.into.native>>)[target]!;
      const { [`response.${target}`]: result, ...response } = await enter({
        ...request,
        'request.http': targetHttp,
        [`request.${target}`]: trip.target,
      });
      const outcome = result as ChatOutcome<ChatOperation>;
      if (outcome.kind === 'error') {
        const http = response['response.http'] as HttpResponseFact | null;
        return { ...response, [sourceOutcome]: translateHttpError(outcome, http, trip.error) };
      }
      if (outcome.kind === 'result') throw new Error(`The ${target} generation body returned a scalar to ${source}`);
      const stream = translateChatFrames({ source, target }, outcome.stream, scope, trip.events);
      return { ...response, [sourceOutcome]: { kind: 'stream', stream } };
    },
  });
};
