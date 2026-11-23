import { createOpenAIResponsesBody } from '../../../../src/data-plane/chat/openai-responses/body.ts';
import { openaiResponsesEgress } from '../../../../src/data-plane/chat/openai-responses/egress.ts';
import { createOpenAIResponsesCompactIngress, createOpenAIResponsesIngress } from '../../../../src/data-plane/chat/openai-responses/ingress.ts';
import { createNonOpenAIResponsesSourceStore } from '../../../../src/data-plane/chat/openai-responses/items/store.ts';
import { AffinityCodec } from '../../../../src/data-plane/chat/shared/affinity/carrier.ts';
import type { ChatBodyOutput, ChatBodyTargets } from '../../../../src/data-plane/chat/shared/route-body.ts';
import { createSidecarCodecFactory } from '../../../../src/data-plane/chat/shared/sidecar-codec.ts';
import type { GatewayHttpFacts } from '../../../../src/data-plane/pipeline/host.ts';
import { createUsageStore, type GatewayServices, type OpenResponsesStore, type RouteCandidate } from '../../../../src/data-plane/pipeline/services.ts';
import { providerRuntimeServices } from '../../../../src/data-plane/providers/upstreams.ts';
import { chatUpstream, type ChatTestUpstream, fetcherFrom, providersFrom } from '../shared/fixture.ts';
import type { Fetcher, FetchInit, HeaderEntry, HttpResponseFacts } from '@floway-dev/http';
import { Bytes, compose, defineEnding, type ErrorSnapshot, link, run, type RunEvent } from '@floway-dev/pipeline';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesRequestPayloadEx } from '@floway-dev/protocols/openai-responses';
import { type FlagId, type ProviderResponsesInput, readHttpBody } from '@floway-dev/provider';

export const key = 'responses-key';
const serverSecret = '41'.repeat(32);
export const headers = [['x-upstream-test', 'present']] as const;

export const readHttpBytes = async (body: HttpResponseFacts['body']): Promise<Bytes> => {
  const result = await readHttpBody(body);
  if (!result.ok) throw new Error(result.error.message);
  return result.bytes;
};

export const wireEvents = <Event>(frames: AsyncIterable<ProtocolFrame<Event>>, headerEntries: ReadonlyArray<readonly [string, string]> = headers): Response => {
  const iterator = frames[Symbol.asyncIterator]();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const reading = await iterator.next();
      if (reading.done) {
        controller.close();
      } else {
        const frame = reading.value;
        const data = frame.type === 'done' ? '[DONE]' : JSON.stringify(frame.event);
        controller.enqueue(new TextEncoder().encode(`data: ${data}\n\n`));
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  }, { highWaterMark: 0 });
  const resultHeaders = new Headers();
  for (const [name, value] of headerEntries) resultHeaders.append(name, value);
  resultHeaders.set('content-type', 'text/event-stream');
  return new Response(body, { headers: resultHeaders });
};

export const fetchBody = (body: FetchInit['body']) =>
  body !== null && typeof body === 'object' && 'open' in body ? body.open() : body;

export const readWireJson = async <T>(body: FetchInit['body']): Promise<T> =>
  await new Response(fetchBody(body)).json() as T;

export interface WireRequest {
  readonly payload: ProviderResponsesInput['request.payload'] & { readonly model: string };
  readonly action: 'generate' | 'compact';
  readonly headers: Headers;
}
export const responsesUpstream = (upstreamId: string, respond: (request: WireRequest) => Response | Promise<Response>, flags: readonly FlagId[] = []) =>
  chatUpstream({
    upstreamId, flags, endpoints: { openaiResponses: {} }, ingressHeadersRules: [{ key: 'user-agent', value: null }],
    fetcher: async (url, init) => await respond({
      payload: await readWireJson(init.body),
      action: new URL(url).pathname.endsWith('/compact') ? 'compact' : 'generate',
      headers: new Headers(init.headers),
    }),
  });

export const imageUpstream = (upstreamId: string, modelId: string, fetcher: Fetcher) => {
  const upstream = chatUpstream({ upstreamId, modelId, fetcher, endpoints: { openaiImagesGenerations: {}, openaiImagesEdits: {} } });
  const { candidate } = upstream;
  return { ...upstream, candidate: { ...candidate, providerModel: { ...candidate.providerModel, kind: 'image' as const } } };
};

type UnusedSpace = ChatBodyOutput<'openaiResponses'> & ChatBodyOutput<'anthropicMessages'> & ChatBodyOutput<'openaiChatCompletions'>;
const unusedExit = ['response.http', 'response.openaiResponses', 'response.anthropicMessages', 'response.openaiChatCompletions'] as const;
export const unusedBody = compose<UnusedSpace, GatewayServices>()('unused translation', {
  entry: [], exit: unusedExit, stages: [],
  ending: defineEnding({
    name: 'unexpectedTranslation',
    request: { needs: [] },
    return: { provides: unusedExit },
    execute: async () => { throw new Error('Unexpected translation'); },
  }),
});

export const responsesFixture = (
  upstreams: readonly ChatTestUpstream[],
  openStore: OpenResponsesStore = () => createNonOpenAIResponsesSourceStore(key),
  targets: Partial<ChatBodyTargets<'openaiResponses'>> = {},
) => {
  const usage: Parameters<GatewayServices['usageStore']['record']>[0][] = [];
  const performance: Parameters<GatewayServices['performanceStore']['record']>[0][] = [];
  const requestedModels: string[] = [];
  const events: RunEvent[] = [];
  const services: GatewayServices = {
    ...providerRuntimeServices,
    providers: {
      async enumerate(facts, model, kind) {
        requestedModels.push(model);
        return await providersFrom(upstreams.filter(value => value.candidate.providerModel.kind === kind)).enumerate(facts, model, kind);
      },
    },
    fetcher: fetcherFrom(upstreams),
    modelsRefresh: async () => ({ refreshed: true }),
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
    messages: unusedBody,
    chatCompletions: unusedBody,
    ...targets,
  };
  const body = createOpenAIResponsesBody({ egress: openaiResponsesEgress, ...translationTargets });
  const generate = createOpenAIResponsesIngress(body);
  const compact = createOpenAIResponsesCompactIngress(body);
  link([generate, compact]);
  const requestRaw = (body: Bytes, action: 'generate' | 'compact', requestHeaders?: readonly HeaderEntry[], uploadError?: ErrorSnapshot) => {
    const input: GatewayHttpFacts = {
      'request.startedAt': Date.now(),
      'request.http': {
        method: 'POST',
        url: { origin: 'https://floway.test', pathname: action === 'compact' ? '/v1/responses/compact' : '/v1/responses' },
        headers: requestHeaders ?? [['user-agent', 'Floway test'], ['x-ignored', 'ignored']],
        body: uploadError === undefined ? body : { kind: 'upload-error', error: uploadError },
      },
      'request.auth.apiKeyId': key,
      'request.auth.user': { id: 1, isAdmin: true },
      'request.route.runtimeLocation': 'TEST',
      'request.route.upstreamIds': null,
      'request.route.randomizeUpstreams': false,
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
