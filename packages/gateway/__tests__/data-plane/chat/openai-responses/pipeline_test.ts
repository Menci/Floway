import { expect, test } from 'vitest';

import { createOpenAIResponsesBody } from '../../../../src/data-plane/chat/openai-responses/body.ts';
import { openaiResponsesEgress } from '../../../../src/data-plane/chat/openai-responses/egress.ts';
import { createOpenAIResponsesCompactIngress, createOpenAIResponsesIngress } from '../../../../src/data-plane/chat/openai-responses/ingress.ts';
import { syntheticEventsFromResult } from '../../../../src/data-plane/chat/openai-responses/items/output.ts';
import { createNonOpenAIResponsesSourceStore, LayeredOpenAIResponsesStatefulStore, MemoryOpenAIResponsesStatefulBacking } from '../../../../src/data-plane/chat/openai-responses/items/store.ts';
import { AffinityCodec } from '../../../../src/data-plane/chat/shared/affinity/carrier.ts';
import type { ChatBodyInput, ChatBodyOutput } from '../../../../src/data-plane/chat/shared/route-body.ts';
import { createSidecarCodecFactory } from '../../../../src/data-plane/chat/shared/sidecar-codec.ts';
import type { HttpOutput } from '../../../../src/data-plane/pipeline/edge-http.ts';
import type { GatewayHttpFacts } from '../../../../src/data-plane/pipeline/host.ts';
import { readHttpBytes } from '../../../../src/data-plane/pipeline/non-chat.ts';
import type { GatewayServices, OpenResponsesStore, RouteCandidate } from '../../../../src/data-plane/pipeline/services.ts';
import type { GatewayProvider } from '../../../../src/data-plane/providers/registry.ts';
import type { HttpResponseFacts } from '@floway-dev/http';
import { Bytes, compose, defineEnding, link, type Pipeline, run, type StageEnv } from '@floway-dev/pipeline';
import type { OpenAIImagesGenerationsPayload } from '@floway-dev/protocols/openai-images';
import type { OpenAIResponsesOutputItemEx, OpenAIResponsesRequestPayloadEx, OpenAIResponsesResultEx } from '@floway-dev/protocols/openai-responses';
import { type ChatTargetApi, type FlagId, type ProviderHttpOutput, type ProviderInput, type ProviderPipelines, type ProviderResponsesInput, type ProviderResponsesOutput, type ProviderServices, toProviderModelFacts } from '@floway-dev/provider';
import { stubProvider, stubProviderModel, testFetcher } from '@floway-dev/test-utils';

const key = 'responses-key';
const serverSecret = '41'.repeat(32);
const headers = [['x-upstream-test', 'present']] as const;

const http = (status = 200, body: HttpResponseFacts['body'] = null): HttpOutput => ({
  'response.http': { status, statusText: '', body, headers, timing: { startedAt: 0, headersAt: 1 } },
});

const modelOutput = (output: OpenAIResponsesOutputItemEx[], usage = { input_tokens: 3, output_tokens: 4, total_tokens: 7 }): OpenAIResponsesResultEx => ({
  id: 'resp_upstream', object: 'response', model: 'test-model', status: 'completed', error: null, incomplete_details: null, output, usage,
});

const message = (text: string): OpenAIResponsesOutputItemEx => ({
  type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', annotations: [], text }],
});

const eventsReply = (env: StageEnv, response = modelOutput([message('answer')])): ProviderResponsesOutput => ({
  ...http(),
  'response.modelKey': 'native-responses',
  'response.events': env.createStream({ label: 'stub Responses events', iterate: () => syntheticEventsFromResult(response) }),
  'response.result': undefined,
});

const providerResponses = (reply: (facts: ProviderResponsesInput, env: StageEnv) => ProviderResponsesOutput | Promise<ProviderResponsesOutput>) =>
  compose<ProviderResponsesInput, ProviderResponsesOutput, ProviderServices>('test.openai-responses', {
    stages: [],
    ending: defineEnding<ProviderResponsesInput, ProviderResponsesOutput>({
      name: 'stubResponses',
      request: { needs: ['provider.model', 'request.headers', 'request.payload', 'request.action'] },
      return: { provides: ['response.http', 'response.modelKey', 'response.events', 'response.result'] },
      execute: async (facts, _into, env) => await reply(facts, env),
    }),
  });

const upstream = (id: string, pipelines: ProviderPipelines, flags: readonly FlagId[] = [], kind: 'chat' | 'image' = 'chat') => {
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

const unusedBody = <Api extends ChatTargetApi>(api: Api): Pipeline<ChatBodyInput<Api>, ChatBodyOutput<Api>, GatewayServices> =>
  compose<ChatBodyInput<Api>, ChatBodyOutput<Api>, GatewayServices>(`unused.${api}`, {
    stages: [],
    ending: defineEnding<ChatBodyInput<Api>, ChatBodyOutput<Api>>({
      name: 'unexpectedTranslation',
      request: { needs: [] },
      return: { provides: ['response.http', `response.${api}`, 'response.usage.billable', 'response.timing.firstOutputAt', 'response.timing.streamEndedAt'] },
      execute: async () => { throw new Error(`Unexpected translation into ${api}`); },
    }),
  });

const fixture = (
  upstreams: ReturnType<typeof upstream>[],
  openStore: OpenResponsesStore = () => createNonOpenAIResponsesSourceStore(key),
) => {
  const usage: Parameters<GatewayServices['usageStore']['record']>[0][] = [];
  const performance: Parameters<GatewayServices['performanceStore']['record']>[0][] = [];
  const services: GatewayServices = {
    providers: {
      resolve(id) {
        const match = upstreams.find(value => value.provider.upstreamId === id);
        if (match === undefined) throw new Error(`Unexpected provider ${id}`);
        return match.provider;
      },
      async enumerate(_facts, _model, kind) {
        const candidates = upstreams.map(value => value.candidate).filter(value => value.providerModel.kind === kind);
        return { candidates, sawModel: candidates.length > 0, failedUpstreams: [] };
      },
    },
    fetcher: () => testFetcher,
    affinityCodec: new AffinityCodec(serverSecret),
    sidecarCodecs: createSidecarCodecFactory(serverSecret),
    responsesStore: openStore,
    usageStore: { record: async row => { usage.push(row); } },
    performanceStore: { record: async row => { performance.push(row); } },
    webSearchProvider: Object.assign(
      async () => ({ type: 'disabled' as const }),
      { alphaSearch: async () => ({ enabled: false, model: '', upstreamId: '' }) },
    ),
  };
  const body = createOpenAIResponsesBody({
    egress: openaiResponsesEgress,
    messages: unusedBody('anthropicMessages'),
    chatCompletions: unusedBody('openaiChatCompletions'),
  });
  const generate = createOpenAIResponsesIngress(body);
  const compact = createOpenAIResponsesCompactIngress(body);
  link([generate, compact]);
  return {
    usage, performance,
    request(payload: OpenAIResponsesRequestPayloadEx, action: 'generate' | 'compact' = 'generate') {
      const input: GatewayHttpFacts = {
        'request.startedAt': Date.now(),
        'request.http': {
          method: 'POST',
          url: { origin: 'https://floway.test', pathname: action === 'compact' ? '/v1/responses/compact' : '/v1/responses' },
          headers: [['user-agent', 'Floway test'], ['x-ignored', 'ignored']],
          body: Bytes.fromUtf8(JSON.stringify(payload)),
        },
        'request.auth.apiKeyId': key,
        'request.auth.user': { id: 1, isAdmin: true },
        'request.route.runtimeLocation': 'TEST',
        'request.route.upstreamIds': null,
        'request.route.randomizeUpstreams': false,
      };
      return run(action === 'generate' ? generate : compact, input, { services, finalizationTimeoutMs: 2000 });
    },
  };
};

test('HTTP Responses hydrates previous_response_id and commits only store-enabled turns', async () => {
  const backing = new MemoryOpenAIResponsesStatefulBacking();
  const calls: ProviderResponsesInput[] = [];
  const mock = fixture([upstream('responses', {
    openaiResponses: providerResponses((facts, env) => {
      calls.push(facts);
      return eventsReply(env);
    }),
  })], mode => {
    if (mode.kind !== 'http') throw new Error('Expected HTTP Responses mode');
    return new LayeredOpenAIResponsesStatefulStore({ apiKeyId: key, reads: [backing], writes: mode.store === false ? [] : [backing] });
  });
  const first = mock.request({ model: 'test-model', input: 'first prompt' });
  const firstResponse = (await first.result)['response.http'];
  expect(firstResponse.status).toBe(200);
  expect(firstResponse.headers).toContainEqual(['x-reasoning-included', 'true']);
  expect(firstResponse.headers).toContainEqual(headers[0]);
  const firstBody = JSON.parse((await readHttpBytes(firstResponse.body)).utf8());
  expect(firstBody).toMatchObject({ object: 'response', store: true, output: [expect.objectContaining({ type: 'reasoning' }), expect.objectContaining({ id: 'msg_1' })] });
  expect(await backing.lookupSnapshot(key, firstBody.id)).toMatchObject({ itemIds: expect.arrayContaining(['msg_1']) });
  expect(await first.done).toEqual({ ok: true });

  const second = mock.request({ model: 'test-model', input: 'second prompt', previous_response_id: firstBody.id, store: false });
  const secondBody = JSON.parse((await readHttpBytes((await second.result)['response.http'].body)).utf8());
  expect(secondBody.store).toBe(false);
  expect(await backing.lookupSnapshot(key, secondBody.id)).toBeNull();
  expect(calls[0]?.['request.headers']).toEqual([['user-agent', 'Floway test']]);
  expect(calls[1]?.['request.payload']).not.toHaveProperty('previous_response_id');
  expect(calls[1]?.['request.payload'].input).toEqual([
    expect.objectContaining({ role: 'user', content: 'first prompt' }),
    expect.objectContaining({ role: 'assistant', id: 'msg_1' }),
    expect.objectContaining({ role: 'user', content: 'second prompt' }),
  ]);
  expect(await second.done).toEqual({ ok: true });
  expect(mock.usage).toHaveLength(2);
});

test('native HTTP compact reads scalar usage and preserves its compact resource', async () => {
  const mock = fixture([upstream('responses', {
    openaiResponses: providerResponses(facts => {
      expect(facts['request.action']).toBe('compact');
      return {
        ...http(),
        'response.modelKey': 'native-compact',
        'response.events': undefined,
        'response.result': {
          id: 'cmp_upstream', object: 'response.compaction',
          output: [{ type: 'compaction', id: 'cmp_1', encrypted_content: 'upstream-opaque' }],
          usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 },
        },
      };
    }),
  })]);
  const handle = mock.request({ model: 'test-model', input: 'compact', stream: true }, 'compact');
  const response = (await handle.result)['response.http'];
  expect(response.status).toBe(200);
  expect(response.headers).not.toContainEqual(['x-reasoning-included', 'true']);
  const body = JSON.parse((await readHttpBytes(response.body)).utf8());
  expect(body).toMatchObject({
    object: 'response.compaction', output: [expect.objectContaining({ id: 'cmp_1', type: 'compaction' })],
    usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 },
  });
  expect(await handle.done).toEqual({ ok: true });
  expect(mock.usage).toEqual([expect.objectContaining({ modelKey: 'native-compact', requests: 1 })]);
  expect(mock.performance).toEqual([expect.objectContaining({ kind: 'neutral' })]);
});

test('compact shim retries a textless turn, reports aggregate usage and records each call', async () => {
  const calls: ProviderResponsesInput[] = [];
  const mock = fixture([upstream('responses', {
    openaiResponses: providerResponses((facts, env) => {
      calls.push(facts);
      expect(facts['request.action']).toBe('generate');
      expect(facts['request.payload'].store).toBe(false);
      return eventsReply(env, modelOutput(calls.length === 1 ? [] : [message('summary')]));
    }),
  }, ['openai-responses-compact-shim'])]);
  const handle = mock.request({ model: 'test-model', input: 'make compact' }, 'compact');
  const response = (await handle.result)['response.http'];
  expect(response.status).toBe(200);
  const body = JSON.parse((await readHttpBytes(response.body)).utf8());
  expect(body.usage).toMatchObject({ input_tokens: 6, output_tokens: 8, total_tokens: 14 });
  expect(calls[0]?.['request.payload'].input[0]).toMatchObject({ role: 'user', content: 'make compact' });
  expect(calls[1]?.['request.payload'].input[0]).toMatchObject({ role: 'system' });
  expect(await handle.done).toEqual({ ok: true });
  expect(mock.usage.map(row => row.requests)).toEqual([1, 1]);
  expect(mock.performance).toHaveLength(1);
});

test('a provider stream failure keeps its JSON resource and marks performance failed', async () => {
  const mock = fixture([upstream('responses', {
    openaiResponses: providerResponses((_facts, env) =>
      eventsReply(env, { ...modelOutput([]), status: 'failed', error: { code: 'server_error', message: 'mock failure' } })),
  })]);
  const handle = mock.request({ model: 'test-model', input: 'try' });
  const response = (await handle.result)['response.http'];
  expect(response.status).toBe(200);
  expect(JSON.parse((await readHttpBytes(response.body)).utf8())).toMatchObject({ status: 'failed', error: { message: 'mock failure' } });
  expect(await handle.done).toEqual({ ok: true });
  expect(mock.usage).toHaveLength(1);
  expect(mock.performance).toEqual([expect.objectContaining({ kind: 'zero-output-error' })]);
});

test('streamed Responses includes the reasoning marker, terminal resource and done trailer', async () => {
  const mock = fixture([upstream('responses', { openaiResponses: providerResponses((_facts, env) => eventsReply(env)) })]);
  const handle = mock.request({ model: 'test-model', input: 'stream', stream: true });
  const response = (await handle.result)['response.http'];
  expect(response.status).toBe(200);
  expect(response.headers).toContainEqual(['x-reasoning-included', 'true']);
  const body = (await readHttpBytes(response.body)).utf8();
  expect(body).toContain('event: response.completed');
  expect(body).toContain('data: [DONE]');
  expect(await handle.done).toEqual({ ok: true });
  expect(mock.usage).toHaveLength(1);
});

test('a ReAct image call retries 429, streams previews and settles separately from both chat rounds', async () => {
  type ImagesInput = ProviderInput<Omit<OpenAIImagesGenerationsPayload, 'model'>>;
  const imageRequests: ImagesInput[] = [];
  const imagePipeline = compose<ImagesInput, ProviderHttpOutput, ProviderServices>('test.images', {
    stages: [],
    ending: defineEnding<ImagesInput, ProviderHttpOutput>({
      name: 'stubImages',
      request: { needs: ['provider.model', 'request.headers', 'request.payload'] },
      return: { provides: ['response.http', 'response.modelKey'] },
      execute: async facts => {
        imageRequests.push(facts);
        if (imageRequests.length === 1) {
          const response = http(429, Bytes.fromUtf8('{"error":{"code":"rate_limit_exceeded","message":"retry"}}'))['response.http'];
          return {
            'response.http': { ...response, headers: [['retry-after-ms', '1']] },
            'response.modelKey': 'native-image',
          };
        }
        return {
          ...http(200, Bytes.fromUtf8([
            'data: {"type":"image_generation.partial_image","partial_image_index":0,"b64_json":"cHJldmlldw=="}\n\n',
            'data: {"type":"image_generation.completed","b64_json":"ZmluYWw=","usage":{"input_tokens":3,"output_tokens":5,"total_tokens":8}}\n\n',
          ].join(''))),
          'response.modelKey': 'native-image',
        };
      },
    }),
  });
  const turns: ProviderResponsesInput[] = [];
  const responsesPipeline = providerResponses((facts, env) => {
    turns.push(facts);
    if (turns.length === 2) return eventsReply(env, modelOutput([message('The image is ready.')]));
    return eventsReply(env, modelOutput([{
      type: 'function_call', id: 'fc_test', call_id: 'call_test', status: 'completed',
      name: 'image_generation', arguments: '{"prompt":"an apple"}',
    }]));
  });
  const mock = fixture([
    upstream('chat', { openaiResponses: responsesPipeline }, ['openai-responses-image-generation-shim']),
    upstream('images', { openaiImagesGenerations: imagePipeline }, [], 'image'),
  ]);
  const handle = mock.request({
    model: 'test-model', input: 'draw something', stream: true,
    tools: [{ type: 'image_generation', model: 'test-model', partial_images: 1 }],
  });
  const response = (await handle.result)['response.http'];
  expect(response.status).toBe(200);
  const body = (await readHttpBytes(response.body)).utf8();
  expect(body).toContain('response.image_generation_call.partial_image');
  expect(body).toContain('cHJldmlldw==');
  expect(body).toContain('ZmluYWw=');
  expect(body).toContain('The image is ready.');
  expect(imageRequests.map(call => call['request.payload'])).toEqual([
    expect.objectContaining({ prompt: 'an apple', stream: true, partial_images: 1 }),
    expect.objectContaining({ prompt: 'an apple', stream: true, partial_images: 1 }),
  ]);
  expect(turns[1]?.['request.payload'].input).toContainEqual(expect.objectContaining({ type: 'function_call_output', call_id: 'call_test' }));
  expect(await handle.done).toEqual({ ok: true });
  expect(mock.usage.map(row => row.modelKey).sort()).toEqual(['native-image', 'native-responses', 'native-responses']);
  expect(mock.performance).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'neutral', dimensions: expect.objectContaining({ operation: 'image_generation' }) }),
    expect.objectContaining({ sample: expect.objectContaining({ operation: 'chat' }) }),
  ]));
});
