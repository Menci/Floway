import { createOpenAIResponsesBody, createOpenAIResponsesCompactBody } from '../../../../src/data-plane/chat/openai-responses/body.ts';
import { openaiResponsesCompactEgress, openaiResponsesEgress } from '../../../../src/data-plane/chat/openai-responses/egress.ts';
import { createOpenAIResponsesCompactIngress, createOpenAIResponsesIngress } from '../../../../src/data-plane/chat/openai-responses/ingress.ts';
import { createNonOpenAIResponsesSourceStore } from '../../../../src/data-plane/chat/openai-responses/items/store.ts';
import { AffinityCodec } from '../../../../src/data-plane/chat/shared/affinity/carrier.ts';
import type { ChatBodyInput, ChatBodyOutput, ChatBodyTargets } from '../../../../src/data-plane/chat/shared/route-body.ts';
import { createSidecarCodecFactory } from '../../../../src/data-plane/chat/shared/sidecar-codec.ts';
import type { HttpOutput } from '../../../../src/data-plane/pipeline/edge-http.ts';
import type { GatewayHttpFacts } from '../../../../src/data-plane/pipeline/host.ts';
import { createUsageStore, type GatewayServices, type OpenResponsesStore, type RouteCandidate } from '../../../../src/data-plane/pipeline/services.ts';
import type { GatewayProvider } from '../../../../src/data-plane/providers/registry.ts';
import type { HeaderEntry, HttpResponseFacts } from '@floway-dev/http';
import { Bytes, compose, defineEnding, type ErrorSnapshot, link, type Pipeline, run, type RunEvent, type StageEnv } from '@floway-dev/pipeline';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesRequestPayloadEx } from '@floway-dev/protocols/openai-responses';
import { type ChatTargetApi, type FlagId, type ProviderPipelines, type ProviderResponsesInput, type ProviderResponsesOutput, type ProviderServices, toProviderModelFacts } from '@floway-dev/provider';
import { stubProvider, stubProviderModel, testFetcher } from '@floway-dev/test-utils';

export const key = 'responses-key';
const serverSecret = '41'.repeat(32);
export const headers = [['x-upstream-test', 'present']] as const;

export const http = (status = 200, body: HttpResponseFacts['body'] = null): HttpOutput => ({
  'response.http': { status, statusText: '', body, headers, timing: { startedAt: 0, headersAt: 1 } },
});

export const providerResponses = (reply: (facts: ProviderResponsesInput, env: StageEnv) => ProviderResponsesOutput | Promise<ProviderResponsesOutput>) =>
  compose<ProviderResponsesInput, ProviderResponsesOutput, ProviderServices>('test.openai-responses', {
    stages: [],
    ending: defineEnding<ProviderResponsesInput, ProviderResponsesOutput>({
      name: 'stubResponses',
      request: { needs: ['provider.model', 'request.headers', 'request.payload', 'request.action'] },
      return: { provides: ['response.http', 'response.modelKey', 'response.events', 'response.result'] },
      execute: async (facts, _into, env) => await reply(facts, env),
    }),
  });

export const upstream = (id: string, pipelines: ProviderPipelines, flags: readonly FlagId[] = [], kind: 'chat' | 'image' = 'chat') => {
  const endpoints = kind === 'chat' ? { openaiResponses: {} } : { openaiImagesGenerations: {} };
  const provider: GatewayProvider = {
    upstreamId: id, kind: 'custom', name: id, modelsCache: null,
    pipelines, instance: stubProvider(), disabledPublicModelIds: [], modelPrefix: null,
    inboundHeaderAllowlist: ['user-agent'], configVersion: 1, modelsRefreshInputHash: '',
  };
  const providerModel = toProviderModelFacts(stubProviderModel({ kind, endpoints, enabledFlags: new Set(flags) }));
  const candidate: RouteCandidate = {
    upstreamId: id, upstreamName: id, kind: provider.kind, modelId: providerModel.id,
    upstreamModelId: providerModel.upstreamModelId, endpoints, limits: {}, providerModel,
  };
  return { provider, candidate };
};

export const unusedBody = <Api extends ChatTargetApi>(api: Api): Pipeline<ChatBodyInput<Api>, ChatBodyOutput<Api>, GatewayServices> =>
  compose<ChatBodyInput<Api>, ChatBodyOutput<Api>, GatewayServices>(`unused.${api}`, {
    stages: [],
    ending: defineEnding<ChatBodyInput<Api>, ChatBodyOutput<Api>>({
      name: 'unexpectedTranslation',
      request: { needs: [] },
      return: { provides: ['response.http', 'response.source', `response.${api}`, 'response.usage.billable', 'response.timing.firstOutputAt', 'response.timing.streamEndedAt'] },
      execute: async () => { throw new Error(`Unexpected translation into ${api}`); },
    }),
  });

export const responsesFixture = (
  upstreams: ReturnType<typeof upstream>[],
  openStore: OpenResponsesStore = () => createNonOpenAIResponsesSourceStore(key),
  targets: Partial<Omit<ChatBodyTargets<'openaiResponses'>, 'egress'>> = {},
) => {
  const usage: Parameters<GatewayServices['usageStore']['record']>[1][] = [];
  const performance: Parameters<GatewayServices['performanceStore']['record']>[0][] = [];
  const requestedModels: string[] = [];
  const events: RunEvent[] = [];
  const services: GatewayServices = {
    providers: {
      resolve(id) {
        const match = upstreams.find(value => value.provider.upstreamId === id);
        if (match === undefined) throw new Error(`Unexpected provider ${id}`);
        return match.provider;
      },
      async enumerate(_facts, model, kind) {
        requestedModels.push(model);
        const candidates = upstreams.map(value => value.candidate).filter(value => value.providerModel.kind === kind);
        return { candidates, sawModel: candidates.length > 0, failedUpstreams: [] };
      },
    },
    fetcher: () => testFetcher,
    affinityCodec: new AffinityCodec(serverSecret),
    sidecarCodecs: createSidecarCodecFactory(serverSecret),
    responsesStore: openStore,
    usageStore: createUsageStore(async row => { usage.push(row); }, async () => {}),
    performanceStore: { record: async row => { performance.push(row); } },
    searchUsageStore: { record: async () => {} },
    webSearchProvider: Object.assign(
      async () => ({ type: 'disabled' as const }),
      { alphaSearch: async () => ({ enabled: false, model: '', upstreamId: '' }) },
    ),
  };
  const translationTargets = {
    messages: unusedBody('anthropicMessages'),
    chatCompletions: unusedBody('openaiChatCompletions'),
    ...targets,
  };
  const body = createOpenAIResponsesBody({ ...translationTargets, egress: openaiResponsesEgress });
  const compactBody = createOpenAIResponsesCompactBody({
    ...translationTargets, egress: openaiResponsesCompactEgress, generation: openaiResponsesEgress,
  });
  const generate = createOpenAIResponsesIngress(body);
  const compact = createOpenAIResponsesCompactIngress(compactBody);
  link([generate, compact]);
  const requestRaw = (body: Bytes, action: 'generate' | 'compact', requestHeaders?: readonly HeaderEntry[], uploadError?: ErrorSnapshot) => {
    const input: GatewayHttpFacts = {
      'request.startedAt': Date.now(),
      'request.http': {
        method: 'POST',
        url: { origin: 'https://floway.test', pathname: action === 'compact' ? '/v1/responses/compact' : '/v1/responses' },
        headers: requestHeaders ?? [['user-agent', 'Floway test'], ['x-ignored', 'ignored']],
        body,
      },
      'request.auth.apiKeyId': key,
      'request.auth.user': { id: 1, isAdmin: true },
      'request.route.runtimeLocation': 'TEST',
      'request.route.upstreamIds': null,
      'request.route.randomizeUpstreams': false,
      ...(uploadError === undefined ? {} : { 'request.uploadError': uploadError }),
    };
    return run(action === 'generate' ? generate : compact, input, {
      services, finalizationTimeoutMs: 2000, events: event => { events.push(event); },
    });
  };
  return {
    usage, performance, requestedModels, services, events, requestRaw,
    invokeBody(payload: CanonicalOpenAIResponsesPayload, candidate: RouteCandidate) {
      return run(body, {
        'request.http': { method: 'POST', url: { origin: 'https://floway.test', pathname: '/v1/test' }, headers: [], body: null },
        'request.auth.apiKeyId': key,
        'request.auth.user': { id: 1, isAdmin: true },
        'request.route.runtimeLocation': 'TEST',
        'request.route.upstreamIds': null,
        'request.route.randomizeUpstreams': false,
        'route.candidate': candidate,
        'request.action': 'generate',
        'request.openaiResponses': payload,
      }, { services, finalizationTimeoutMs: 2000 });
    },
    request(payload: OpenAIResponsesRequestPayloadEx, action: 'generate' | 'compact' = 'generate', requestHeaders?: readonly HeaderEntry[]) {
      return requestRaw(Bytes.fromUtf8(JSON.stringify(payload)), action, requestHeaders);
    },
  };
};
