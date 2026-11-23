import { createNonOpenAIResponsesSourceStore } from '../../../../../src/data-plane/chat/openai-responses/items/store.ts';
import { AffinityCodec } from '../../../../../src/data-plane/chat/shared/affinity/carrier.ts';
import { createSidecarCodecFactory } from '../../../../../src/data-plane/chat/shared/sidecar-codec.ts';
import { type HttpOutput, jsonHttpResponse } from '../../../../../src/data-plane/pipeline/edge-http.ts';
import type { GatewayHttpFacts } from '../../../../../src/data-plane/pipeline/host.ts';
import { billableCall, emptyUsageFacts, observeIdentity, observedTokenUsage, type UsageFacts, usageResponseKeys } from '../../../../../src/data-plane/pipeline/observe-usage.ts';
import { createUsageStore, type GatewayServices, type RouteCandidate } from '../../../../../src/data-plane/pipeline/services.ts';
import type { HeaderEntry } from '@floway-dev/http';
import { type Bytes, compose, defineEnding, type ManagedStream, run, type Stage } from '@floway-dev/pipeline';
import type { BillableUsage, ProtocolFrame } from '@floway-dev/protocols/common';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import { type ChatTargetApi, type FlagId, type OpenAIResponsesAction, type ProviderResponsesOutput, toProviderModelFacts } from '@floway-dev/provider';
import { stubProviderModel, testFetcher } from '@floway-dev/test-utils';

export type Frame = ProtocolFrame<OpenAIResponsesStreamEventEx>;
export interface UpstreamEvents {
  readonly events: AsyncIterable<Frame>;
  readonly usage?: Promise<BillableUsage | undefined>;
  readonly modelKey?: string;
}
export interface UpstreamScalar {
  readonly result: NonNullable<ProviderResponsesOutput['response.result']>;
  readonly usage?: Promise<BillableUsage>;
}
interface UpstreamFailure {
  readonly failure: { readonly status: number; readonly headers: readonly HeaderEntry[]; readonly body: Bytes; readonly source: 'upstream' | 'gateway' };
}
type UpstreamReply = AsyncIterable<Frame> | UpstreamEvents | UpstreamScalar | UpstreamFailure;

export interface StageOptions {
  readonly enabledFlags?: ReadonlySet<FlagId>;
  readonly targetApi?: ChatTargetApi;
  readonly action?: OpenAIResponsesAction;
  readonly wire?: boolean;
  readonly apiKeyId?: string;
  readonly signal?: AbortSignal;
  readonly services?: Partial<GatewayServices>;
  readonly upstream?: (payload: CanonicalOpenAIResponsesPayload, action: OpenAIResponsesAction) => UpstreamReply | Promise<UpstreamReply>;
}

interface Request extends GatewayHttpFacts {
  readonly 'request.openaiResponses': CanonicalOpenAIResponsesPayload;
  readonly 'request.payload': CanonicalOpenAIResponsesPayload;
  readonly 'request.action': OpenAIResponsesAction;
  readonly 'route.candidate': RouteCandidate;
  readonly 'route.targetApi': ChatTargetApi;
}

interface Reply extends HttpOutput, UsageFacts, Partial<Omit<ProviderResponsesOutput, 'response.http'>> {
  readonly 'response.source': 'upstream' | 'gateway';
  readonly 'response.openaiResponses'?: ManagedStream<Frame>;
}

const secret = '22'.repeat(32);
const services: GatewayServices = {
  providers: {
    resolve(upstreamId) { throw new Error(`Unexpected upstream selection: ${upstreamId}`); },
    async enumerate() { throw new Error('Unexpected candidate enumeration'); },
  },
  fetcher: () => testFetcher,
  affinityCodec: new AffinityCodec(secret),
  sidecarCodecs: createSidecarCodecFactory(secret),
  responsesStore: () => createNonOpenAIResponsesSourceStore('test-key'),
  usageStore: createUsageStore(async () => {}, async () => {}),
  performanceStore: { record: async () => {} },
  searchUsageStore: { record: async () => {} },
  webSearchProvider: Object.assign(
    async () => ({ type: 'disabled' as const }),
    { alphaSearch: async () => ({ enabled: false, model: '', upstreamId: '' }) },
  ),
};

export const driveResponsesStages = async (stages: readonly Stage<GatewayServices>[], before: CanonicalOpenAIResponsesPayload, options: StageOptions = {}) => {
  const { enabledFlags = new Set(), targetApi = 'openaiResponses', action = 'generate', wire = false, upstream } = options;
  const providerModel = toProviderModelFacts(stubProviderModel({ enabledFlags }));
  let seen: CanonicalOpenAIResponsesPayload | undefined;
  const logs: string[] = [];
  const pipeline = compose<Request, Reply, GatewayServices>('test.responses.stage', {
    stages,
    ending: defineEnding<Request, Reply>({
      name: 'stubResponses',
      request: { needs: [wire ? 'request.payload' : 'request.openaiResponses'] },
      return: { provides: ['response.http', 'response.source', 'response.openaiResponses', 'response.events', 'response.result', 'response.modelKey', ...usageResponseKeys] },
      execute: async (facts, _into, env) => {
        seen = facts[wire ? 'request.payload' : 'request.openaiResponses'];
        const scripted = await upstream?.(seen, facts['request.action']);
        const events = scripted === undefined || 'result' in scripted || 'failure' in scripted ? undefined : 'events' in scripted ? scripted.events : scripted;
        const usage = scripted === undefined || !('usage' in scripted) ? undefined : scripted.usage;
        const modelKey = scripted !== undefined && 'modelKey' in scripted && scripted.modelKey !== undefined ? scripted.modelKey : providerModel.upstreamModelId;
        const timing = emptyUsageFacts(env);
        const billing = usage === undefined ? timing : {
          ...timing,
          'response.usage.billable': env.defer('test billable calls', usage.then(measured => measured === undefined ? [] :
              [billableCall(env, observeIdentity(facts['route.candidate'], modelKey), 'completed', observedTokenUsage(measured))])),
        };
        const failure = scripted !== undefined && 'failure' in scripted ? scripted.failure : undefined;
        const stream = events === undefined ? undefined : env.createStream({ label: 'stub upstream events', iterate: () => events });
        return {
          'response.http': failure === undefined ? jsonHttpResponse(200, {}, env.clock()) : {
            status: failure.status, statusText: '', headers: failure.headers, body: failure.body, timing: { startedAt: env.clock(), headersAt: env.clock() },
          },
          'response.source': failure?.source ?? 'upstream',
          'response.modelKey': modelKey,
          'response.openaiResponses': wire ? undefined : stream,
          'response.events': wire ? stream : undefined,
          'response.result': scripted !== undefined && 'result' in scripted ? scripted.result : undefined,
          ...billing,
        };
      },
    }),
  });
  const handle = run(pipeline, {
    'request.http': { method: 'POST', url: { origin: 'https://floway.test', pathname: '/v1/responses' }, headers: [], body: null },
    'request.auth.apiKeyId': options.apiKeyId ?? 'test-key',
    'request.auth.user': { id: 1, isAdmin: true },
    'request.route.upstreamIds': null,
    'request.route.randomizeUpstreams': false,
    'request.route.runtimeLocation': 'TEST',
    'request.openaiResponses': before,
    'request.payload': before,
    'request.action': action,
    'route.targetApi': targetApi,
    'route.candidate': {
      upstreamId: 'test-upstream', upstreamName: 'Test Upstream', kind: 'custom',
      modelId: providerModel.id, upstreamModelId: providerModel.upstreamModelId,
      endpoints: providerModel.endpoints, limits: providerModel.limits, providerModel,
    },
  }, {
    services: { ...services, ...options.services }, signal: options.signal, finalizationTimeoutMs: 2000,
    events: event => { if (event.k === 'log') logs.push(event.message); },
  });
  const result = await handle.result;
  return { before, seen, result, done: handle.done, logs };
};

export const driveResponsesStage = (stage: Stage<GatewayServices>, payload: CanonicalOpenAIResponsesPayload, options?: StageOptions) =>
  driveResponsesStages([stage], payload, options);
