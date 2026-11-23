import { createAnthropicMessagesBody, createAnthropicMessagesCountBody } from '../../../../src/data-plane/chat/anthropic-messages/body.ts';
import { anthropicMessagesCountEgress, anthropicMessagesEgress } from '../../../../src/data-plane/chat/anthropic-messages/egress.ts';
import { createAnthropicMessagesCountIngress, createAnthropicMessagesIngress } from '../../../../src/data-plane/chat/anthropic-messages/ingress.ts';
import type { AnthropicMessagesFrame } from '../../../../src/data-plane/chat/anthropic-messages/stages/facts.ts';
import { createNonOpenAIResponsesSourceStore } from '../../../../src/data-plane/chat/openai-responses/items/store.ts';
import { AffinityCodec } from '../../../../src/data-plane/chat/shared/affinity/carrier.ts';
import type { ChatBodyInput, ChatBodyOutput, ChatBodyTargets } from '../../../../src/data-plane/chat/shared/route-body.ts';
import { createSidecarCodecFactory } from '../../../../src/data-plane/chat/shared/sidecar-codec.ts';
import type { HttpOutput } from '../../../../src/data-plane/pipeline/edge-http.ts';
import { type GatewayHttpFacts, httpRequestFacts } from '../../../../src/data-plane/pipeline/host.ts';
import { type GatewayServices, type RouteCandidate } from '../../../../src/data-plane/pipeline/services.ts';
import { writeHttpResponse } from '../../../../src/data-plane/shared/http-writer.ts';
import type { HttpResponseFacts } from '@floway-dev/http';
import { Bytes, compose, defineEnding, link, type Pipeline, run, type RunEvent, type StageEnv } from '@floway-dev/pipeline';
import { createAnthropicMessagesUsage, type AnthropicMessagesPayload, type AnthropicMessagesStreamEventEx, toAnthropicMessagesUsageDelta } from '@floway-dev/protocols/anthropic-messages';
import { doneFrame, eventFrame } from '@floway-dev/protocols/common';
import { type ChatTargetApi, type FlagId, type ProviderAnthropicInput, type ProviderHttpOutput, type ProviderPipelines, type ProviderStreamOutput, toProviderModelFacts } from '@floway-dev/provider';
import { stubProvider, stubProviderModel, testFetcher } from '@floway-dev/test-utils';

const secret = '22'.repeat(32);
export const messagesPayload = (overrides: Partial<AnthropicMessagesPayload> = {}): AnthropicMessagesPayload => ({
  model: 'test-model', max_tokens: 32, messages: [{ role: 'user', content: 'hello' }], ...overrides,
});

export const httpReply = (status: number, body: HttpResponseFacts['body'] = null, headers: HttpResponseFacts['headers'] = []): HttpOutput => ({
  'response.http': { status, statusText: '', body, headers, timing: { startedAt: 1, headersAt: 2 } },
});

export const defaultFrames = async function* (): AsyncGenerator<AnthropicMessagesFrame> {
  const usage = createAnthropicMessagesUsage(3, 5);
  yield eventFrame({
    type: 'message_start',
    message: {
      id: 'msg_1', type: 'message', role: 'assistant', model: 'test-model', content: [],
      stop_reason: null, stop_details: null, stop_sequence: null, container: null, diagnostics: null, usage,
    },
  });
  yield eventFrame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'answer', citations: null } });
  yield eventFrame({ type: 'content_block_stop', index: 0 });
  yield eventFrame({ type: 'message_delta', delta: { container: null, stop_reason: 'end_turn', stop_details: null, stop_sequence: null }, usage: toAnthropicMessagesUsageDelta(usage) });
  yield eventFrame({ type: 'message_stop' });
  yield doneFrame();
};

type GenerateOutput = ProviderStreamOutput<AnthropicMessagesStreamEventEx>;
export const generateReply = (env: StageEnv, frames: () => AsyncIterable<AnthropicMessagesFrame> = defaultFrames): GenerateOutput => ({
  ...httpReply(200),
  'response.modelKey': 'test-model-key',
  'response.events': env.createStream({ label: 'provider frames', iterate: frames }),
});

const providerRequest = { needs: ['provider.model', 'request.headers', 'request.payload', 'request.anthropicBeta'] };

export const generateProvider = (respond: (facts: ProviderAnthropicInput, env: StageEnv) => GenerateOutput | Promise<GenerateOutput> = (_facts, env) => generateReply(env)) =>
  compose<ProviderAnthropicInput, GenerateOutput, {}>('test messages provider', {
    stages: [],
    ending: defineEnding<ProviderAnthropicInput, GenerateOutput>({
      name: 'generate', request: providerRequest,
      return: { provides: ['response.http', 'response.modelKey', 'response.events'] },
      execute: async (facts, _into, env) => await respond(facts, env),
    }),
  });

export const countProvider = (respond: (facts: ProviderAnthropicInput, env: StageEnv) => HttpOutput | Promise<HttpOutput> = () =>
  httpReply(200, Bytes.fromUtf8('{"input_tokens":42}'), [['content-type', 'application/json']])) =>
  compose<ProviderAnthropicInput, ProviderHttpOutput, {}>('test messages count provider', {
    stages: [],
    ending: defineEnding<ProviderAnthropicInput, ProviderHttpOutput>({
      name: 'count', request: providerRequest,
      return: { provides: ['response.http', 'response.modelKey'] },
      execute: async (facts, _into, env) => ({ ...await respond(facts, env), 'response.modelKey': 'test-model-key' }),
    }),
  });

export const messagesUpstream = (options: {
  upstreamId?: string;
  model?: string;
  flags?: readonly FlagId[];
  endpoints?: RouteCandidate['endpoints'];
  rules?: RouteCandidate['rules'];
  pipelines?: ProviderPipelines;
} = {}) => {
  const upstreamId = options.upstreamId ?? 'test-upstream';
  const modelId = options.model ?? 'test-model';
  const endpoints = options.endpoints ?? { anthropicMessages: {} };
  const provider: ReturnType<GatewayServices['providers']['resolve']> = {
    upstreamId, kind: 'custom', name: upstreamId, modelsCache: null,
    disabledPublicModelIds: [], modelPrefix: null, inboundHeaderAllowlist: ['anthropic-beta'],
    configVersion: 1, modelsRefreshInputHash: '',
    instance: stubProvider(),
    pipelines: options.pipelines ?? { anthropicMessages: generateProvider(), anthropicMessagesCountTokens: countProvider() },
  };
  const candidate: RouteCandidate = {
    upstreamId, upstreamName: upstreamId, kind: provider.kind, modelId, upstreamModelId: modelId,
    endpoints, limits: {},
    providerModel: toProviderModelFacts(stubProviderModel({
      id: modelId, upstreamModelId: modelId, endpoints, enabledFlags: new Set(options.flags),
    })),
    ...(options.rules === undefined ? {} : { rules: options.rules }),
  };
  return { candidate, provider };
};

export const unusedBody = <Api extends ChatTargetApi>(api: Api): Pipeline<ChatBodyInput<Api>, ChatBodyOutput<Api>, GatewayServices> =>
  compose<ChatBodyInput<Api>, ChatBodyOutput<Api>, GatewayServices>(`unused ${api}`, {
    stages: [],
    ending: defineEnding<ChatBodyInput<Api>, ChatBodyOutput<Api>>({
      name: 'unexpected', request: { needs: [] },
      return: { provides: ['response.http', 'response.source', `response.${api}`, 'response.usage.billable', 'response.timing.firstOutputAt', 'response.timing.streamEndedAt'] },
      execute: async () => { throw new Error(`Unexpected translation into ${api}`); },
    }),
  });

export const messagesFixture = (upstreams = [messagesUpstream()], options: {
  readonly responses?: ChatBodyTargets<'anthropicMessages'>['responses'];
  readonly webSearchProvider?: GatewayServices['webSearchProvider'];
  readonly failedUpstreams?: readonly string[];
  readonly sawModel?: boolean;
} = {}) => {
  const events: RunEvent[] = [];
  const usage: Parameters<GatewayServices['usageStore']['record']>[0][] = [];
  const performance: Parameters<GatewayServices['performanceStore']['record']>[0][] = [];
  const requestedModels: string[] = [];
  const services: GatewayServices = {
    providers: {
      resolve: id => {
        const upstream = upstreams.find(upstream => upstream.provider.upstreamId === id);
        if (upstream === undefined) throw new Error(`Unexpected upstream ${id}`);
        return upstream.provider;
      },
      enumerate: async (_facts, model) => {
        requestedModels.push(model);
        return {
          candidates: upstreams.map(value => value.candidate),
          sawModel: options.sawModel ?? upstreams.length > 0,
          failedUpstreams: options.failedUpstreams ?? [],
        };
      },
    },
    fetcher: () => testFetcher,
    affinityCodec: new AffinityCodec(secret),
    sidecarCodecs: createSidecarCodecFactory(secret),
    responsesStore: () => createNonOpenAIResponsesSourceStore('test-key'),
    usageStore: { record: async row => { usage.push(row); } },
    performanceStore: { record: async row => { performance.push(row); } },
    webSearchProvider: options.webSearchProvider ?? Object.assign(
      async () => ({ type: 'disabled' as const }),
      { alphaSearch: async () => ({ enabled: false, upstreamId: '', model: '' }) },
    ),
  };
  const body = createAnthropicMessagesBody({
    egress: anthropicMessagesEgress,
    responses: options.responses ?? unusedBody('openaiResponses'),
    chatCompletions: unusedBody('openaiChatCompletions'),
  });
  const countBody = createAnthropicMessagesCountBody({ egress: anthropicMessagesCountEgress });
  const generate = createAnthropicMessagesIngress(body);
  const count = createAnthropicMessagesCountIngress(countBody);
  link([generate, count]);

  const send = async (payload: unknown, opts: { readonly count?: boolean; readonly headers?: HeadersInit } = {}) => {
    const path = opts.count ? '/v1/messages/count_tokens' : '/v1/messages';
    const request = new Request(`https://gateway.test${path}`, { method: 'POST', headers: opts.headers });
    const input: GatewayHttpFacts = {
      'request.http': httpRequestFacts(request, Bytes.fromUtf8(JSON.stringify(payload))),
      'request.auth.apiKeyId': 'test-key',
      'request.auth.user': { id: 1, isAdmin: false },
      'request.route.upstreamIds': null,
      'request.route.randomizeUpstreams': false,
      'request.route.runtimeLocation': 'SJC',
    };
    const handle = run(opts.count ? count : generate, input, { services, finalizationTimeoutMs: 1_000, events: event => { events.push(event); } });
    const facts = await handle.result;
    return { facts, response: writeHttpResponse(facts['response.http']), done: handle.done };
  };

  return { send, events, usage, performance, requestedModels };
};
