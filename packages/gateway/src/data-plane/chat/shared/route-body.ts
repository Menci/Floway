import { SidecarDomain } from './sidecar-codec.ts';
import { type HttpInput, jsonHttpResponse } from '../../pipeline/edge-http.ts';
import type { AttemptResponse, CandidateRequest } from '../../pipeline/failover.ts';
import { httpSucceeded, readHttpBytes } from '../../pipeline/non-chat.ts';
import { emptyUsageFacts, usageResponseKeys } from '../../pipeline/observe-usage.ts';
import type { GatewayRouteFacts, GatewayServices } from '../../pipeline/services.ts';
import type { HttpResponseFacts } from '@floway-dev/http';
import { Bytes, defineEnding, type ManagedStream, type StageEnv, type StaticTarget, type ThroughDecl } from '@floway-dev/pipeline';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentRequest, GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIChatCompletionsPayloadEx, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIResponsesRequestPayloadEx, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import type { ChatTargetApi, OpenAIResponsesAction } from '@floway-dev/provider';
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

interface ChatProtocols {
  readonly anthropicMessages: [AnthropicMessagesPayload, AnthropicMessagesStreamEventEx];
  readonly geminiGenerateContent: [GeminiGenerateContentRequest, GeminiGenerateContentStreamEvent];
  readonly openaiChatCompletions: [OpenAIChatCompletionsPayloadEx, OpenAIChatCompletionsStreamEvent];
  readonly openaiResponses: [OpenAIResponsesRequestPayloadEx & { model: string }, OpenAIResponsesStreamEventEx];
}

export type ChatPayload<Api extends ChatTargetApi> = ChatProtocols[Api][0];
export type ChatEvent<Api extends ChatTargetApi> = ChatProtocols[Api][1];
export type ChatFrames<Event> = ManagedStream<ProtocolFrame<Event>> | undefined;

export type ChatPayloadFacts<Api extends ChatTargetApi, Payload = ChatPayload<Api>> = { readonly [K in `request.${Api}`]: Payload };
export type ChatFrameFacts<Api extends ChatTargetApi, Event = ChatEvent<Api>> = { readonly [K in `response.${Api}`]: ChatFrames<Event> };

export interface ChatProtocolExtras {
  readonly 'request.anthropicBeta'?: readonly string[];
  readonly 'request.action'?: OpenAIResponsesAction;
}

type BodyRequest = HttpInput & CandidateRequest & GatewayRouteFacts & ChatProtocolExtras & {
  readonly 'route.translationSource'?: ChatTargetApi;
};

export type ChatBodyInput<Api extends ChatTargetApi> = BodyRequest & ChatPayloadFacts<Api>;
export type ChatBodyOutput<Api extends ChatTargetApi> = AttemptResponse & ChatFrameFacts<Api> & {
  readonly 'response.targetApi'?: ChatTargetApi;
};
export type ChatEgressInput<Api extends ChatTargetApi> = BodyRequest & { readonly 'request.payload': ChatPayload<Api> };
export interface ChatEgressOutput<Api extends ChatTargetApi> extends AttemptResponse {
  readonly 'response.events': ChatFrames<ChatEvent<Api>>;
  readonly 'response.targetApi': ChatTargetApi;
}

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
type TargetBodyRequest = BodyRequest & { readonly 'route.targetApi': ChatTargetApi };
type RouteRequest<Api extends ChatTargetApi> = TargetBodyRequest & ChatPayloadFacts<Api>;
type InputErrorBody = (error: TranslateInputError) => unknown;
type RouteReply<Event, Reply> = (response: AttemptResponse, events: ChatFrames<Event>) => Reply;
type EnterEgress<Payload, Event> = (
  facts: BodyRequest & { readonly 'request.payload': Payload },
) => Promise<AttemptResponse & { readonly 'response.events': ChatFrames<Event> }>;
type EnterBody<Api extends ChatTargetApi> = (facts: ChatBodyInput<Api>) => Promise<ChatBodyOutput<Api>>;
type TranslatedAnswer<Payload, Event> = (
  facts: BodyRequest, payload: Payload,
) => Promise<{ readonly response: AttemptResponse; readonly events: ChatFrames<Event> }>;

const responseDecl = (consumes: string, provides: string, passthrough: readonly string[]): ThroughDecl['response'] => ({
  needs: ['response.http', ...usageResponseKeys, consumes, ...passthrough],
  consumes: [consumes],
  provides: ['response.http', provides],
});

const egressSlot = (api: ChatTargetApi): ThroughDecl => {
  const request = `request.${api}`;
  return {
    request: { needs: [request], consumes: [request], provides: ['request.payload'] },
    response: responseDecl('response.events', `response.${api}`, ['response.targetApi']),
  };
};

const translationSlot = (source: ChatTargetApi, target: TranslatedApis[TranslationSlot]): ThroughDecl => {
  const request = `request.${source}`;
  const extras = target === 'anthropicMessages' ? ['request.anthropicBeta'] : target === 'openaiResponses' ? ['request.action'] : [];
  return {
    request: {
      needs: [request],
      consumes: [request],
      provides: [`request.${target}`, 'route.translationSource', ...extras],
    },
    response: responseDecl(`response.${target}`, `response.${source}`, []),
  };
};

const routeDefinition = (api: ChatTargetApi) => ({
  name: 'routeBody',
  request: { needs: [`request.${api}`, 'route.targetApi', 'route.candidate'] },
  return: { provides: ['response.http', `response.${api}`, ...usageResponseKeys] },
});

export const headersForRewrite = (headers: HttpResponseFacts['headers']): Headers => {
  const result = new Headers();
  for (const [name, value] of headers) result.append(name, typeof value === 'string' ? value : value.reveal());
  return result;
};

const rewriteTranslatedError = async (http: HttpResponseFacts, rewrite: TranslateTrip<unknown, unknown, unknown>['error']): Promise<HttpResponseFacts> => {
  if (httpSucceeded(http) || http.body === null) return http;
  const bytes = await readHttpBytes(http.body);
  const rewritten = rewrite(http.status, headersForRewrite(http.headers), bytes.toUint8Array());
  if (rewritten === undefined) return { ...http, body: bytes };
  return {
    ...http,
    status: rewritten.status,
    statusText: rewritten.status === http.status ? http.statusText : '',
    headers: [...rewritten.headers],
    body: Bytes.fromUtf8(JSON.stringify(rewritten.body)),
  };
};

const enterEgress = async <Payload, Event, Reply>(
  facts: BodyRequest, payload: Payload, enter: EnterEgress<Payload, Event>, reply: RouteReply<Event, Reply>,
): Promise<Reply> => {
  const { 'response.events': events, ...response } = await enter({ ...facts, 'request.payload': payload });
  return reply(response, events);
};

const translateInto = async <Payload extends object, Event, TargetPayload, TargetEvent, Reply>(
  api: ChatTargetApi,
  facts: TargetBodyRequest,
  payload: Payload,
  translate: Translator<Payload, Event, TargetPayload, TargetEvent>,
  enter: TranslatedAnswer<TargetPayload, TargetEvent>,
  reply: RouteReply<Event, Reply>,
  inputError: InputErrorBody,
  env: StageEnv<RouteServices>,
): Promise<Reply> => {
  const targetApi = facts['route.targetApi'];
  const source = facts['route.translationSource'];
  if (source !== undefined) throw new Error(`Chat request from ${source} reached a second translation from ${api} to ${targetApi}`);
  if (api === 'openaiResponses' && facts['request.action'] === 'compact') throw new Error('Responses compact reached a translation without the compact shim');
  const trip = await translate({ ...payload, stream: true }, {
    sidecarCodec: env.services.sidecarCodecs.codecFor(SidecarDomain.TranslatedAssistantTurn),
    fallbackMaxOutputTokens: facts['route.candidate'].limits.max_output_tokens,
  });
  if (trip.type === 'input-error') {
    return reply({ 'response.http': jsonHttpResponse(400, inputError(trip), env.clock()), ...emptyUsageFacts(env) }, undefined);
  }
  const { response, events } = await enter({ ...facts, 'route.translationSource': api }, trip.target);
  return reply({
    ...response,
    'response.http': await rewriteTranslatedError(response['response.http'], trip.error),
  }, events === undefined ? undefined : env.wrapStream(events, {
    label: `${targetApi} → ${api}`,
    transform: source => trip.events(source),
  }));
};

const intoMessages = (call: EnterBody<'anthropicMessages'>): TranslatedAnswer<AnthropicMessagesPayload, AnthropicMessagesStreamEventEx> => async (facts, payload) => {
  const { 'response.anthropicMessages': events, ...response } = await call({
    ...facts, 'request.anthropicMessages': payload, 'request.anthropicBeta': [],
  });
  return { response, events };
};

const intoResponses = (call: EnterBody<'openaiResponses'>): TranslatedAnswer<ChatPayload<'openaiResponses'>, OpenAIResponsesStreamEventEx> => async (facts, payload) => {
  const { 'response.openaiResponses': events, ...response } = await call({
    ...facts, 'request.openaiResponses': payload, 'request.action': 'generate',
  });
  return { response, events };
};

const intoChatCompletions = (call: EnterBody<'openaiChatCompletions'>): TranslatedAnswer<OpenAIChatCompletionsPayloadEx, OpenAIChatCompletionsStreamEvent> => async (facts, payload) => {
  const { 'response.openaiChatCompletions': events, ...response } = await call({ ...facts, 'request.openaiChatCompletions': payload });
  return { response, events };
};

const noRoute = (api: ChatTargetApi, targetApi: ChatTargetApi): never => {
  throw new Error(`Chat protocol ${api} has no route to ${targetApi}`);
};

export const createOpenAIChatCompletionsRouteBody = (inputError: InputErrorBody) => {
  const api = 'openaiChatCompletions';
  type Api = typeof api;
  const reply: RouteReply<ChatEvent<Api>, ChatBodyOutput<Api>> = (response, events) => ({ ...response, 'response.openaiChatCompletions': events });
  return defineEnding<RouteRequest<Api>, ChatBodyOutput<Api>, ChatBodyTargets<Api>, RouteServices>({
    ...routeDefinition(api),
    into: {
      egress: egressSlot(api),
      messages: translationSlot(api, 'anthropicMessages'),
      responses: translationSlot(api, 'openaiResponses'),
    },
    execute: async ({ 'request.openaiChatCompletions': payload, ...facts }, into, env) => {
      switch (facts['route.targetApi']) {
      case 'openaiChatCompletions': return await enterEgress(facts, payload, into.egress, reply);
      case 'anthropicMessages': return await translateInto(api, facts, payload, routeOpenAIChatCompletionsViaAnthropicMessages, intoMessages(into.messages), reply, inputError, env);
      case 'openaiResponses': return await translateInto(api, facts, payload, routeOpenAIChatCompletionsViaOpenAIResponses, intoResponses(into.responses), reply, inputError, env);
      default: return noRoute(api, facts['route.targetApi']);
      }
    },
  });
};

export const createOpenAIResponsesRouteBody = (inputError: InputErrorBody) => {
  const api = 'openaiResponses';
  type Api = typeof api;
  const reply: RouteReply<ChatEvent<Api>, ChatBodyOutput<Api>> = (response, events) => ({ ...response, 'response.openaiResponses': events });
  return defineEnding<RouteRequest<Api>, ChatBodyOutput<Api>, ChatBodyTargets<Api>, RouteServices>({
    ...routeDefinition(api),
    into: {
      egress: egressSlot(api),
      messages: translationSlot(api, 'anthropicMessages'),
      chatCompletions: translationSlot(api, 'openaiChatCompletions'),
    },
    execute: async ({ 'request.openaiResponses': payload, ...facts }, into, env) => {
      switch (facts['route.targetApi']) {
      case 'openaiResponses': return await enterEgress(facts, payload, into.egress, reply);
      case 'anthropicMessages': return await translateInto(api, facts, payload, routeOpenAIResponsesViaAnthropicMessages, intoMessages(into.messages), reply, inputError, env);
      case 'openaiChatCompletions': return await translateInto(api, facts, payload, routeOpenAIResponsesViaOpenAIChatCompletions, intoChatCompletions(into.chatCompletions), reply, inputError, env);
      default: return noRoute(api, facts['route.targetApi']);
      }
    },
  });
};

export const createAnthropicMessagesRouteBody = (inputError: InputErrorBody) => {
  const api = 'anthropicMessages';
  type Api = typeof api;
  const reply: RouteReply<ChatEvent<Api>, ChatBodyOutput<Api>> = (response, events) => ({ ...response, 'response.anthropicMessages': events });
  return defineEnding<RouteRequest<Api>, ChatBodyOutput<Api>, ChatBodyTargets<Api>, RouteServices>({
    ...routeDefinition(api),
    into: {
      egress: egressSlot(api),
      responses: translationSlot(api, 'openaiResponses'),
      chatCompletions: translationSlot(api, 'openaiChatCompletions'),
    },
    execute: async ({ 'request.anthropicMessages': payload, ...facts }, into, env) => {
      switch (facts['route.targetApi']) {
      case 'anthropicMessages': return await enterEgress(facts, payload, into.egress, reply);
      case 'openaiResponses': return await translateInto(api, facts, payload, routeAnthropicMessagesViaOpenAIResponses, intoResponses(into.responses), reply, inputError, env);
      case 'openaiChatCompletions': return await translateInto(api, facts, payload, routeAnthropicMessagesViaOpenAIChatCompletions, intoChatCompletions(into.chatCompletions), reply, inputError, env);
      default: return noRoute(api, facts['route.targetApi']);
      }
    },
  });
};

export const createGeminiGenerateContentRouteBody = (inputError: InputErrorBody) => {
  const api = 'geminiGenerateContent';
  type Api = typeof api;
  const reply: RouteReply<ChatEvent<Api>, ChatBodyOutput<Api>> = (response, events) => ({ ...response, 'response.geminiGenerateContent': events });
  return defineEnding<RouteRequest<Api>, ChatBodyOutput<Api>, ChatBodyTargets<Api>, RouteServices>({
    ...routeDefinition(api),
    into: {
      egress: egressSlot(api),
      messages: translationSlot(api, 'anthropicMessages'),
      responses: translationSlot(api, 'openaiResponses'),
      chatCompletions: translationSlot(api, 'openaiChatCompletions'),
    },
    execute: async ({ 'request.geminiGenerateContent': payload, ...facts }, into, env) => {
      switch (facts['route.targetApi']) {
      case 'geminiGenerateContent': return await enterEgress(facts, payload, into.egress, reply);
      case 'anthropicMessages': return await translateInto(api, facts, payload, routeGeminiGenerateContentViaAnthropicMessages, intoMessages(into.messages), reply, inputError, env);
      case 'openaiResponses': return await translateInto(api, facts, payload, routeGeminiGenerateContentViaOpenAIResponses, intoResponses(into.responses), reply, inputError, env);
      case 'openaiChatCompletions': return await translateInto(api, facts, payload, routeGeminiGenerateContentViaOpenAIChatCompletions, intoChatCompletions(into.chatCompletions), reply, inputError, env);
      }
    },
  });
};

export const enterChatBody = <Api extends ChatTargetApi>(api: Api) => {
  type Request = ChatBodyInput<Api>;
  type Response = ChatBodyOutput<Api>;
  type Targets = { body: StaticTarget<Request, Response, GatewayServices> };
  const requestKey = `request.${api}`;
  return defineEnding<Request, Response, Targets>({
    name: 'enterBody',
    request: { needs: [requestKey, 'route.candidate', 'request.http'] },
    into: {
      body: {
        request: { needs: [], consumes: [], provides: [] },
        response: responseDeclNoChanges(api),
      },
    },
    execute: async (facts, into) => await into.body(facts),
  });
};

const responseDeclNoChanges = (api: ChatTargetApi): ThroughDecl['response'] => ({
  needs: ['response.http', `response.${api}`, ...usageResponseKeys],
  consumes: [],
  provides: [],
});
