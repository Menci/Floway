import { removeFact } from './remove-fact.ts';
import { SidecarDomain } from './sidecar-codec.ts';
import { wrapProtocolFrames } from './stream-frames.ts';
import type { TargetRequest } from './target-picker.ts';
import { type HttpInput, type HttpOutput, jsonHttpResponse } from '../../pipeline/edge-http.ts';
import type { CandidateRequest } from '../../pipeline/failover.ts';
import type { GatewayRouteFacts, GatewayServices } from '../../pipeline/services.ts';
import type { HttpResponseFacts } from '@floway-dev/http';
import { Bytes, defineEnding, type FactValue, type Scope, type StaticTarget, type ThroughDecl } from '@floway-dev/pipeline';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { GeminiGenerateContentRequest, GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIChatCompletionsPayloadEx, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIResponsesCompactionResultEx, OpenAIResponsesRequestPayloadEx, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import type { ChatTargetApi, OpenAIResponsesAction, ProtocolOutcome, ProviderBaseOutput } from '@floway-dev/provider';
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
  type Translator,
} from '@floway-dev/translate';

interface ChatProtocols {
  readonly anthropicMessages: [AnthropicMessagesPayload, AnthropicMessagesStreamEventEx, never];
  readonly geminiGenerateContent: [GeminiGenerateContentRequest, GeminiGenerateContentStreamEvent, never];
  readonly openaiChatCompletions: [OpenAIChatCompletionsPayloadEx, OpenAIChatCompletionsStreamEvent, never];
  readonly openaiResponses: [OpenAIResponsesRequestPayloadEx & { model: string }, OpenAIResponsesStreamEventEx, OpenAIResponsesCompactionResultEx];
}

export type ChatPayload<Api extends ChatTargetApi> = ChatProtocols[Api][0];
export type ChatEvent<Api extends ChatTargetApi> = ChatProtocols[Api][1];
export type ChatResult<Api extends ChatTargetApi> = ChatProtocols[Api][2];

export type ChatPayloadFacts<Api extends ChatTargetApi, Payload = ChatPayload<Api>> = { readonly [K in `request.${Api}`]: Payload };
export type ChatOutcomeFacts<Api extends ChatTargetApi, Event = ChatEvent<Api>, Result = ChatResult<Api>> =
  Readonly<Record<`response.${Api}`, ProtocolOutcome<Event, Result>>>;

export type ChatProtocolExtras<Api extends ChatTargetApi> = Api extends 'anthropicMessages'
  ? { readonly 'request.anthropicBeta': readonly string[] }
  : Api extends 'openaiResponses' ? { readonly 'request.action': OpenAIResponsesAction } : {};

type BodyRequest = HttpInput & CandidateRequest & GatewayRouteFacts;

export type ChatBodyInput<Api extends ChatTargetApi> = BodyRequest & ChatProtocolExtras<Api> & ChatPayloadFacts<Api>;
export type ChatBodyOutput<Api extends ChatTargetApi> = HttpOutput & ChatOutcomeFacts<Api>;
export type ChatEgressInput<Api extends ChatTargetApi> =
  BodyRequest & ChatProtocolExtras<Api> & TargetRequest<Api> & { readonly 'request.payload': ChatPayload<Api> };
export type ChatEgressOutput<Api extends ChatTargetApi> = ProviderBaseOutput & ChatOutcomeFacts<Api>;

interface TranslatedApis {
  readonly messages: 'anthropicMessages';
  readonly responses: 'openaiResponses';
  readonly chatCompletions: 'openaiChatCompletions';
}
type TranslationSlot = keyof TranslatedApis;
type SlotsFor<Api extends ChatTargetApi> = {
  [K in TranslationSlot]: TranslatedApis[K] extends Api ? never : K;
}[TranslationSlot];

export type ChatBodyTargets<Api extends ChatTargetApi> = {
  readonly egress: StaticTarget<ChatEgressInput<Api>, ChatEgressOutput<Api>, GatewayServices>;
} & {
  readonly [Slot in SlotsFor<Api>]: StaticTarget<ChatBodyInput<TranslatedApis[Slot]>, ChatBodyOutput<TranslatedApis[Slot]>, GatewayServices>;
};

type RouteServices = Pick<GatewayServices, 'sidecarCodecs'>;
type TargetBodyRequest = BodyRequest & TargetRequest;
type RouteRequest<Api extends ChatTargetApi> = ChatBodyInput<Api> & TargetRequest<Api | TranslatedApis[SlotsFor<Api>]>;
type InputErrorBody = (error: TranslateInputError) => unknown;
type RouteReply<Event, Reply> = (http: HttpResponseFacts, outcome: ProtocolOutcome<Event>) => Reply;
type EnterBody<Api extends ChatTargetApi> = (facts: ChatBodyInput<Api>) => Promise<ChatBodyOutput<Api>>;
type TranslatedAnswer<Payload, Event, Result> = (
  facts: BodyRequest, payload: Payload,
) => Promise<{ readonly http: HttpResponseFacts; readonly outcome: ProtocolOutcome<Event, Result> }>;

const extrasFor = (target: ChatTargetApi): readonly string[] => {
  if (target === 'anthropicMessages') return ['request.anthropicBeta'];
  if (target === 'openaiResponses') return ['request.action'];
  return [];
};

const egressSlot = (api: ChatTargetApi): ThroughDecl => {
  const request = `request.${api}`;
  return {
    request: { needs: [request, ...extrasFor(api)], consumes: [request], provides: ['request.payload'] },
    response: { needs: ['response.http', 'response.modelKey', `response.${api}`], consumes: ['response.modelKey'], provides: [] },
  };
};

const translationSlot = (source: ChatTargetApi, target: TranslatedApis[TranslationSlot]): ThroughDecl => {
  const request = `request.${source}`;
  return {
    request: {
      needs: [request],
      consumes: [request],
      provides: [`request.${target}`, ...extrasFor(target)],
    },
    response: {
      needs: ['response.http', `response.${target}`],
      consumes: [`response.${target}`],
      provides: ['response.http', `response.${source}`],
    },
  };
};

const routeDefinition = (api: ChatTargetApi) => ({
  name: 'routeBody',
  request: { needs: [`request.${api}`, 'route.targetApi', 'route.candidate'] },
  return: { provides: ['response.http', `response.${api}`] },
});

export const headersForRewrite = (headers: HttpResponseFacts['headers']): Headers => {
  const result = new Headers();
  for (const [name, value] of headers) result.append(name, typeof value === 'string' ? value : value.reveal());
  return result;
};

const enterEgress = async <Api extends ChatTargetApi>(
  facts: ChatEgressInput<Api>, enter: (facts: ChatEgressInput<Api>) => Promise<ChatEgressOutput<Api>>,
): Promise<ChatBodyOutput<Api>> => {
  return removeFact<ChatBodyOutput<Api>, 'response.modelKey'>(await enter(facts), 'response.modelKey');
};

const translateInto = async <Payload extends object, Event, TargetPayload, TargetEvent, TargetResult, Reply>(
  api: ChatTargetApi,
  facts: TargetBodyRequest,
  payload: Payload,
  translate: Translator<Payload, Event, TargetPayload, TargetEvent>,
  enter: TranslatedAnswer<TargetPayload, TargetEvent, TargetResult>,
  reply: RouteReply<Event, Reply>,
  inputError: InputErrorBody,
  scope: Scope<RouteServices>,
): Promise<Reply> => {
  const targetApi = facts['route.targetApi'];
  const trip = await translate({ ...payload, stream: true }, {
    sidecarCodec: scope.services.sidecarCodecs.codecFor(SidecarDomain.TranslatedAssistantTurn),
    fallbackMaxOutputTokens: facts['route.candidate'].limits.max_output_tokens,
  });
  if (trip.type === 'input-error') {
    const error = inputError(trip) as FactValue;
    return reply(jsonHttpResponse(400, error, scope.clock()), { kind: 'error', source: 'local', error });
  }
  const { http, outcome } = await enter(facts, trip.target);
  switch (outcome.kind) {
  case 'stream':
    return reply(http, { kind: 'stream', events: wrapProtocolFrames(outcome.events, scope, `${targetApi} → ${api}`, trip.events) });
  case 'result':
    throw new Error(`The ${targetApi} generation pipeline returned a scalar result during translation`);
  case 'error': {
    const bytes = Bytes.fromUtf8(JSON.stringify(outcome.error));
    const rewritten = http.transportError === undefined ? trip.error(http.status, headersForRewrite(http.headers), bytes.toUint8Array()) : undefined;
    if (rewritten === undefined) return reply(http, outcome);
    return reply({
      ...http,
      status: rewritten.status,
      statusText: rewritten.status === http.status ? http.statusText : '',
      headers: [...rewritten.headers],
      body: null,
    }, { ...outcome, error: rewritten.body as FactValue });
  }
  }
};

const intoMessages = (call: EnterBody<'anthropicMessages'>): TranslatedAnswer<AnthropicMessagesPayload, AnthropicMessagesStreamEventEx, never> => async (facts, payload) => {
  const response = await call({ ...facts, 'request.anthropicMessages': payload, 'request.anthropicBeta': [] });
  return { http: response['response.http'], outcome: response['response.anthropicMessages'] };
};

const intoResponses = (call: EnterBody<'openaiResponses'>): TranslatedAnswer<ChatPayload<'openaiResponses'>, OpenAIResponsesStreamEventEx, ChatResult<'openaiResponses'>> => async (facts, payload) => {
  const response = await call({ ...facts, 'request.openaiResponses': payload, 'request.action': 'generate' });
  return { http: response['response.http'], outcome: response['response.openaiResponses'] };
};

const intoChatCompletions = (call: EnterBody<'openaiChatCompletions'>): TranslatedAnswer<OpenAIChatCompletionsPayloadEx, OpenAIChatCompletionsStreamEvent, never> => async (facts, payload) => {
  const response = await call({ ...facts, 'request.openaiChatCompletions': payload });
  return { http: response['response.http'], outcome: response['response.openaiChatCompletions'] };
};

export const createOpenAIChatCompletionsRouteBody = (inputError: InputErrorBody) => {
  const api = 'openaiChatCompletions';
  type Api = typeof api;
  const reply: RouteReply<ChatEvent<Api>, ChatBodyOutput<Api>> = (http, outcome) => ({ 'response.http': http, 'response.openaiChatCompletions': outcome });
  return defineEnding<RouteRequest<Api>, ChatBodyOutput<Api>, ChatBodyTargets<Api>, RouteServices>({
    ...routeDefinition(api),
    into: {
      egress: egressSlot(api),
      messages: translationSlot(api, 'anthropicMessages'),
      responses: translationSlot(api, 'openaiResponses'),
    },
    execute: async ({ 'request.openaiChatCompletions': payload, ...facts }, scope) => {
      const targetApi = facts['route.targetApi'];
      switch (targetApi) {
      case 'openaiChatCompletions': return await enterEgress<Api>({ ...facts, 'route.targetApi': targetApi, 'request.payload': payload }, scope.into.egress);
      case 'anthropicMessages': return await translateInto(api, facts, payload, routeOpenAIChatCompletionsViaAnthropicMessages, intoMessages(scope.into.messages), reply, inputError, scope);
      case 'openaiResponses': return await translateInto(api, facts, payload, routeOpenAIChatCompletionsViaOpenAIResponses, intoResponses(scope.into.responses), reply, inputError, scope);
      }
    },
  });
};

export const createOpenAIResponsesRouteBody = (inputError: InputErrorBody) => {
  const api = 'openaiResponses';
  type Api = typeof api;
  const reply: RouteReply<ChatEvent<Api>, ChatBodyOutput<Api>> = (http, outcome) => ({ 'response.http': http, 'response.openaiResponses': outcome });
  return defineEnding<RouteRequest<Api>, ChatBodyOutput<Api>, ChatBodyTargets<Api>, RouteServices>({
    ...routeDefinition(api),
    into: {
      egress: egressSlot(api),
      messages: translationSlot(api, 'anthropicMessages'),
      chatCompletions: translationSlot(api, 'openaiChatCompletions'),
    },
    execute: async ({ 'request.openaiResponses': payload, ...facts }, scope) => {
      const targetApi = facts['route.targetApi'];
      if (targetApi === api) return await enterEgress<Api>({ ...facts, 'route.targetApi': targetApi, 'request.payload': payload }, scope.into.egress);
      if (facts['request.action'] !== 'generate') throw new Error('Responses compact reached a translation without the compact shim');
      switch (targetApi) {
      case 'anthropicMessages': return await translateInto(api, facts, payload, routeOpenAIResponsesViaAnthropicMessages, intoMessages(scope.into.messages), reply, inputError, scope);
      case 'openaiChatCompletions': return await translateInto(api, facts, payload, routeOpenAIResponsesViaOpenAIChatCompletions, intoChatCompletions(scope.into.chatCompletions), reply, inputError, scope);
      }
    },
  });
};

export const createAnthropicMessagesRouteBody = (inputError: InputErrorBody) => {
  const api = 'anthropicMessages';
  type Api = typeof api;
  const reply: RouteReply<ChatEvent<Api>, ChatBodyOutput<Api>> = (http, outcome) => ({ 'response.http': http, 'response.anthropicMessages': outcome });
  return defineEnding<RouteRequest<Api>, ChatBodyOutput<Api>, ChatBodyTargets<Api>, RouteServices>({
    ...routeDefinition(api),
    into: {
      egress: egressSlot(api),
      responses: translationSlot(api, 'openaiResponses'),
      chatCompletions: translationSlot(api, 'openaiChatCompletions'),
    },
    execute: async ({ 'request.anthropicMessages': payload, ...facts }, scope) => {
      const targetApi = facts['route.targetApi'];
      switch (targetApi) {
      case 'anthropicMessages': return await enterEgress<Api>({ ...facts, 'route.targetApi': targetApi, 'request.payload': payload }, scope.into.egress);
      case 'openaiResponses': return await translateInto(api, facts, payload, routeAnthropicMessagesViaOpenAIResponses, intoResponses(scope.into.responses), reply, inputError, scope);
      case 'openaiChatCompletions': return await translateInto(api, facts, payload, routeAnthropicMessagesViaOpenAIChatCompletions, intoChatCompletions(scope.into.chatCompletions), reply, inputError, scope);
      }
    },
  });
};

export const createGeminiGenerateContentRouteBody = (inputError: InputErrorBody) => {
  const api = 'geminiGenerateContent';
  type Api = typeof api;
  const reply: RouteReply<ChatEvent<Api>, ChatBodyOutput<Api>> = (http, outcome) => ({ 'response.http': http, 'response.geminiGenerateContent': outcome });
  return defineEnding<RouteRequest<Api>, ChatBodyOutput<Api>, ChatBodyTargets<Api>, RouteServices>({
    ...routeDefinition(api),
    into: {
      egress: egressSlot(api),
      messages: translationSlot(api, 'anthropicMessages'),
      responses: translationSlot(api, 'openaiResponses'),
      chatCompletions: translationSlot(api, 'openaiChatCompletions'),
    },
    execute: async ({ 'request.geminiGenerateContent': payload, ...facts }, scope) => {
      const targetApi = facts['route.targetApi'];
      switch (targetApi) {
      case 'geminiGenerateContent': return await enterEgress<Api>({ ...facts, 'route.targetApi': targetApi, 'request.payload': payload }, scope.into.egress);
      case 'anthropicMessages': return await translateInto(api, facts, payload, routeGeminiGenerateContentViaAnthropicMessages, intoMessages(scope.into.messages), reply, inputError, scope);
      case 'openaiResponses': return await translateInto(api, facts, payload, routeGeminiGenerateContentViaOpenAIResponses, intoResponses(scope.into.responses), reply, inputError, scope);
      case 'openaiChatCompletions': return await translateInto(api, facts, payload, routeGeminiGenerateContentViaOpenAIChatCompletions, intoChatCompletions(scope.into.chatCompletions), reply, inputError, scope);
      }
    },
  });
};

export const enterChatBody = <Api extends ChatTargetApi>(api: Api) => {
  type Request = ChatBodyInput<Api>;
  type Response = ChatBodyOutput<Api>;
  type Targets = { body: StaticTarget<Request, Response, GatewayServices> };
  return defineEnding<Request, Response, Targets>({
    name: 'enterBody',
    request: { needs: [`request.${api}`, 'route.candidate', 'request.http', ...extrasFor(api)] },
    into: {
      body: {
        request: { needs: [], consumes: [], provides: [] },
        response: responseDeclNoChanges(api),
      },
    },
    execute: async (facts, scope) => await scope.into.body(facts),
  });
};

const responseDeclNoChanges = (api: ChatTargetApi): ThroughDecl['response'] => ({
  needs: ['response.http', `response.${api}`],
  consumes: [],
  provides: [],
});
