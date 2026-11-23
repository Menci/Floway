import { removeFact } from './remove-fact.ts';
import { SidecarDomain } from './sidecar-codec.ts';
import { type HttpInput, jsonHttpResponse } from '../../pipeline/edge-http.ts';
import type { AttemptResponse, CandidateRequest } from '../../pipeline/failover.ts';
import { httpSucceeded, readHttpBytes } from '../../pipeline/non-chat.ts';
import { emptyUsageFacts, usageResponseKeys } from '../../pipeline/observe-usage.ts';
import type { GatewayRouteFacts, GatewayServices } from '../../pipeline/services.ts';
import type { HttpResponseFacts } from '@floway-dev/http';
import { Bytes, defineEnding, type IntoMap, type ManagedStream, type StageEnv, type StaticTarget, type ThroughDecl } from '@floway-dev/pipeline';
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

const translatedApis = {
  messages: 'anthropicMessages',
  responses: 'openaiResponses',
  chatCompletions: 'openaiChatCompletions',
} as const;
type TranslatedApis = typeof translatedApis;
type TranslationSlot = keyof TranslatedApis;
type SlotsFor<Api extends ChatTargetApi> = {
  [K in TranslationSlot]: TranslatedApis[K] extends Api ? never : K;
}[TranslationSlot];

export type ChatBodyTargets<Api extends ChatTargetApi> = {
  readonly egress: StaticTarget<ChatEgressInput<Api>, ChatEgressOutput<Api>, GatewayServices>;
} & {
  readonly [Slot in SlotsFor<Api>]: StaticTarget<ChatBodyInput<TranslatedApis[Slot]>, ChatBodyOutput<TranslatedApis[Slot]>, GatewayServices>;
};

type ChatTranslator<Source extends ChatTargetApi, Target extends ChatTargetApi> =
  Translator<ChatPayload<Source>, ChatEvent<Source>, ChatPayload<Target>, ChatEvent<Target>>;

const translators = {
  anthropicMessages: {
    responses: routeAnthropicMessagesViaOpenAIResponses,
    chatCompletions: routeAnthropicMessagesViaOpenAIChatCompletions,
  },
  geminiGenerateContent: {
    messages: routeGeminiGenerateContentViaAnthropicMessages,
    responses: routeGeminiGenerateContentViaOpenAIResponses,
    chatCompletions: routeGeminiGenerateContentViaOpenAIChatCompletions,
  },
  openaiChatCompletions: {
    messages: routeOpenAIChatCompletionsViaAnthropicMessages,
    responses: routeOpenAIChatCompletionsViaOpenAIResponses,
  },
  openaiResponses: {
    messages: routeOpenAIResponsesViaAnthropicMessages,
    chatCompletions: routeOpenAIResponsesViaOpenAIChatCompletions,
  },
} satisfies { [A in ChatTargetApi]: { [Slot in SlotsFor<A>]: ChatTranslator<A, TranslatedApis[Slot]> } };

const translationExtras = {
  anthropicMessages: { 'request.anthropicBeta': [] },
  openaiChatCompletions: {},
  openaiResponses: { 'request.action': 'generate' },
} as const;

type RouteServices = Pick<GatewayServices, 'sidecarCodecs'>;
type TranslationTarget = TranslatedApis[TranslationSlot];
type BodyCall = (facts: BodyRequest & object) => Promise<AttemptResponse & Readonly<Record<string, unknown>>>;

const responseDecl = (consumes: string, provides: string, passthrough: readonly string[]): ThroughDecl['response'] => ({
  needs: ['response.http', ...usageResponseKeys, consumes, ...passthrough],
  consumes: [consumes],
  provides: ['response.http', provides],
});

export const headersForRewrite = (headers: HttpResponseFacts['headers']): Headers => {
  const result = new Headers();
  for (const [name, value] of headers) result.append(name, typeof value === 'string' ? value : value.reveal());
  return result;
};

const rewriteTranslatedError = async (
  http: HttpResponseFacts, rewrite: Parameters<typeof rewriteError>[1],
): Promise<HttpResponseFacts> => {
  if (httpSucceeded(http) || http.body === null) return http;
  const bytes = await readHttpBytes(http.body);
  return rewriteError({ ...http, body: bytes }, rewrite);
};

const rewriteError = (
  http: HttpResponseFacts & { readonly body: Bytes },
  rewrite: (status: number, headers: Headers, body: Uint8Array) => {
    readonly status: number;
    readonly headers: Headers;
    readonly body: unknown;
  } | undefined,
): HttpResponseFacts => {
  const rewritten = rewrite(http.status, headersForRewrite(http.headers), http.body.toUint8Array());
  if (rewritten === undefined) return http;
  return {
    ...http,
    status: rewritten.status,
    statusText: rewritten.status === http.status ? http.statusText : '',
    headers: [...rewritten.headers],
    body: Bytes.fromUtf8(JSON.stringify(rewritten.body)),
  };
};

export const createRouteBody = <Api extends ChatTargetApi>(
  api: Api,
  inputError: (error: TranslateInputError) => unknown,
) => {
  type Request = ChatBodyInput<Api> & { readonly 'route.targetApi': ChatTargetApi };
  type Response = ChatBodyOutput<Api>;
  type Targets = ChatBodyTargets<Api>;
  const requestKey = `request.${api}` as const;
  const responseKey = `response.${api}` as const;
  const availableSlots = Object.keys(translators[api]) as SlotsFor<Api>[];
  const egress = {
    request: { needs: [requestKey], consumes: [requestKey], provides: ['request.payload'] },
    response: responseDecl('response.events', responseKey, ['response.targetApi']),
  };
  const declarations = Object.fromEntries(availableSlots.map(slot => {
    const target = translatedApis[slot];
    return [slot, {
      request: {
        needs: [requestKey],
        consumes: [requestKey],
        provides: [`request.${target}`, 'route.translationSource', ...Object.keys(translationExtras[target])],
      },
      response: responseDecl(`response.${target}`, responseKey, []),
    }];
  }));
  const renameResponse = (response: AttemptResponse, events: ChatFrames<ChatEvent<Api>>): Response =>
    ({ ...response, [responseKey]: events }) as Response;
  const definition = {
    name: 'routeBody',
    request: { needs: [requestKey, 'route.targetApi', 'route.candidate'] },
    into: { egress, ...declarations } as { readonly [K in keyof Targets]: ThroughDecl },
    return: { provides: ['response.http', responseKey, ...usageResponseKeys] },
    execute: async (request: Request, into: IntoMap<Targets>, env: StageEnv<RouteServices>) => {
      const payload = request[requestKey];
      const facts = removeFact<BodyRequest & { readonly 'route.targetApi': ChatTargetApi }, typeof requestKey>(request, requestKey);
      const calls = into as {
        egress: (facts: ChatEgressInput<Api>) => Promise<ChatEgressOutput<Api>>;
      } & Partial<Record<TranslationSlot, BodyCall>>;
      const target = facts['route.targetApi'];
      if (target === api) {
        const { 'response.events': events, ...response } = await calls.egress({ ...facts, 'request.payload': payload });
        return renameResponse(response, events);
      }
      if (facts['route.translationSource'] !== undefined) {
        throw new Error(`Chat request from ${facts['route.translationSource']} reached a second translation from ${api} to ${target}`);
      }
      const slot = availableSlots.find(name => translatedApis[name] === target);
      if (slot === undefined) throw new Error(`Chat protocol ${api} has no route to ${target}`);
      if (api === 'openaiResponses' && facts['request.action'] === 'compact') {
        throw new Error('Responses compact reached a translation without the compact shim');
      }
      const targetApi: TranslationTarget = translatedApis[slot];
      // The registry above checks each source and slot pair before the dispatch lookup.
      const lookup = translators[api] as Partial<Record<TranslationSlot, ChatTranslator<Api, TranslationTarget>>>;
      const translator = lookup[slot]!;
      const trip = await translator({ ...payload, stream: true }, {
        sidecarCodec: env.services.sidecarCodecs.codecFor(SidecarDomain.TranslatedAssistantTurn),
        fallbackMaxOutputTokens: facts['route.candidate'].limits.max_output_tokens,
      });
      if (trip.type === 'input-error') {
        return renameResponse({
          'response.http': jsonHttpResponse(400, inputError(trip), env.clock()),
          ...emptyUsageFacts(env),
        }, undefined);
      }
      const call = calls[slot];
      if (call === undefined) throw new Error(`Chat route has no ${slot} slot`);
      const returned = await call({
        ...facts,
        ...translationExtras[targetApi],
        [`request.${targetApi}`]: trip.target,
        'route.translationSource': api,
      });
      const targetResponseKey = `response.${targetApi}`;
      const events = returned[targetResponseKey] as ChatFrames<ChatEvent<TranslationTarget>>;
      const response = removeFact<AttemptResponse, typeof targetResponseKey>(returned, targetResponseKey);
      return renameResponse({
        ...response,
        'response.http': await rewriteTranslatedError(response['response.http'], trip.error),
      }, events === undefined ? undefined : env.wrapStream(events, {
        label: `${targetApi} → ${api}`,
        transform: source => trip.events(source),
      }));
    },
  };
  // Every protocol supplies an egress target; the generic target keys defer the kernel's nonempty check.
  type DefineOptions = Parameters<typeof defineEnding<Request, Response, Targets, RouteServices>>[0];
  return defineEnding<Request, Response, Targets, RouteServices>(definition as typeof definition & DefineOptions);
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
