import { createNonOpenAIResponsesSourceStore } from '../../../../../src/data-plane/chat/openai-responses/items/store.ts';
import { AffinityCodec } from '../../../../../src/data-plane/chat/shared/affinity/carrier.ts';
import { observeOpenAIResponsesCall } from '../../../../../src/data-plane/chat/shared/observe-usage.ts';
import type { ChatEgressOutput } from '../../../../../src/data-plane/chat/shared/route-body.ts';
import { createSidecarCodecFactory } from '../../../../../src/data-plane/chat/shared/sidecar-codec.ts';
import { priceCall, recordCall } from '../../../../../src/data-plane/pipeline/call-metering.ts';
import { jsonHttpResponse } from '../../../../../src/data-plane/pipeline/edge-http.ts';
import { GATEWAY_HTTP_ENTRY, type GatewayHttpFacts } from '../../../../../src/data-plane/pipeline/host.ts';
import { createUsageStore, type GatewayServices, type RouteCandidate } from '../../../../../src/data-plane/pipeline/services.ts';
import { providerRuntimeServices } from '../../../../../src/data-plane/providers/upstreams.ts';
import { chatUpstream, eventOutcome, providersFrom } from '../../shared/fixture.ts';
import type { HeaderEntry } from '@floway-dev/http';
import { type Bytes, compose, defineEnding, type FactValue, link, run, type Stage } from '@floway-dev/pipeline';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesCompactionResultEx, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import type { ChatTargetApi, FlagId, OpenAIResponsesAction, ProviderFrame } from '@floway-dev/provider';
import { testFetcher } from '@floway-dev/test-utils';

export type Frame = ProtocolFrame<OpenAIResponsesStreamEventEx>;
export interface UpstreamEvents {
  readonly events: AsyncIterable<ProviderFrame<OpenAIResponsesStreamEventEx>>;
  readonly modelKey?: string;
}
export interface UpstreamScalar {
  readonly result: OpenAIResponsesCompactionResultEx;
}
interface UpstreamFailure {
  readonly failure: { readonly status: number; readonly headers: readonly HeaderEntry[]; readonly body: Bytes; readonly source: 'upstream' | 'local' };
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

const secret = '22'.repeat(32);
const services: GatewayServices = {
  ...providerRuntimeServices,
  providers: providersFrom([]),
  fetcher: () => testFetcher,
  modelsRefresh: async () => ({ refreshed: true }),
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
  const { candidate } = chatUpstream({ flags: [...enabledFlags], endpoints: { openaiResponses: {} } });
  let seen: CanonicalOpenAIResponsesPayload | undefined;
  const logs: string[] = [];
  const usage: Parameters<GatewayServices['usageStore']['record']>[0][] = [];
  const performance: Parameters<GatewayServices['performanceStore']['record']>[0][] = [];
  const entry = [...GATEWAY_HTTP_ENTRY, 'request.openaiResponses', 'request.payload', 'request.action', 'route.candidate', 'route.targetApi'] as const;
  const exit = ['response.http', 'response.openaiResponses'] as const;
  const pipeline = compose<Request & ChatEgressOutput<'openaiResponses'>, GatewayServices>()('test.responses.stage', {
    entry,
    exit,
    stages: [...stages, recordCall('chat'), priceCall, observeOpenAIResponsesCall],
    ending: defineEnding<Request, ChatEgressOutput<'openaiResponses'>>({
      name: 'stubResponses',
      request: { needs: [wire ? 'request.payload' : 'request.openaiResponses'] },
      return: { provides: [...exit, 'response.modelKey'] },
      execute: async (facts, scope) => {
        seen = facts[wire ? 'request.payload' : 'request.openaiResponses'];
        const scripted = await upstream?.(seen, facts['request.action']);
        const modelKey = scripted !== undefined && 'modelKey' in scripted && scripted.modelKey !== undefined ? scripted.modelKey : candidate.upstreamModelId;
        if (scripted !== undefined && 'failure' in scripted) {
          const failure = scripted.failure;
          const error = JSON.parse(failure.body.utf8()) as FactValue;
          return {
            'response.http': { status: failure.status, statusText: '', headers: failure.headers, body: failure.body, timing: { startedAt: scope.clock(), headersAt: scope.clock() } },
            'response.modelKey': modelKey,
            'response.openaiResponses': { kind: 'error', source: failure.source, error },
          };
        }
        const outcome: ChatEgressOutput<'openaiResponses'>['response.openaiResponses'] = scripted === undefined
          ? { kind: 'error', source: 'local', error: null }
          : 'result' in scripted ? { kind: 'result', result: scripted.result }
            : eventOutcome(scope, 'events' in scripted ? scripted.events : scripted);
        return {
          'response.http': { ...jsonHttpResponse(scripted === undefined ? 400 : 200, {}, scope.clock()), body: null },
          'response.modelKey': modelKey,
          'response.openaiResponses': outcome,
        };
      },
    }),
  });
  link([pipeline]);
  const handle = run(pipeline, {
    'request.http': { method: 'POST', url: { origin: 'https://floway.test', pathname: '/v1/responses' }, headers: [], body: null },
    'request.startedAt': Date.now(),
    'request.auth.apiKeyId': options.apiKeyId ?? 'test-key',
    'request.auth.user': { id: 1, isAdmin: true },
    'request.route.upstreamIds': null,
    'request.route.randomizeUpstreams': false,
    'request.route.runtimeLocation': 'TEST',
    'request.openaiResponses': before,
    'request.payload': before,
    'request.action': action,
    'route.targetApi': targetApi,
    'route.candidate': candidate,
  }, {
    services: {
      ...services,
      usageStore: createUsageStore(async row => { usage.push(row); }, async () => {}),
      performanceStore: { record: async row => { performance.push(row); } },
      ...options.services,
    },
    signal: options.signal,
    finalizationTimeoutMs: 2000,
    events: event => { if (event.k === 'log') logs.push(event.message); },
  });
  const result = await handle.result;
  return { before, seen, result, done: handle.done, logs, usage, performance };
};

export const driveResponsesStage = (stage: Stage<GatewayServices>, payload: CanonicalOpenAIResponsesPayload, options?: StageOptions) =>
  driveResponsesStages([stage], payload, options);
