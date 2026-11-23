import { Hono } from 'hono';
import { expect, test, vi } from 'vitest';

import { createEncode, type DeliveryFacts } from '../../../src/data-plane/chat/shared/encode.ts';
import type { ChatOutcomeFacts } from '../../../src/data-plane/chat/shared/route-body.ts';
import { createObserveCall, observedTokenUsage, priceCall, recordCall } from '../../../src/data-plane/pipeline/call-metering.ts';
import { edgeHttp, type HttpDeliveryFacts, type HttpInput, type HttpOutput, jsonHttpResponse, stripFlowayAuth } from '../../../src/data-plane/pipeline/edge-http.ts';
import { type CandidateRequest, type CandidatesRequest, createFailover } from '../../../src/data-plane/pipeline/failover.ts';
import { createGatewayHttpHandler, GATEWAY_HTTP_ENTRY, type GatewayHttpFacts, startGatewayRun } from '../../../src/data-plane/pipeline/host.ts';
import { createNonChatPipeline, parseJsonModel, scalarHttpAttempt } from '../../../src/data-plane/pipeline/non-chat.ts';
import type { RenderFacts } from '../../../src/data-plane/pipeline/render.ts';
import { createGatewayServices, createUsageStore, type GatewayServices, type RouteCandidate } from '../../../src/data-plane/pipeline/services.ts';
import type { UpstreamFacts } from '../../../src/data-plane/providers/upstreams.ts';
import { writeHttpResponse } from '../../../src/data-plane/shared/http-writer.ts';
import { UpstreamTransportError } from '../../../src/dial/transport-error.ts';
import type { AuthVars } from '../../../src/middleware/auth.ts';
import type { ApiKey, UsageRecord } from '../../../src/repo/types.ts';
import { initBackgroundSchedulerResolver } from '../../../src/runtime/background.ts';
import { isTransportFailure } from '@floway-dev/http';
import { Bytes, compose, defineEnding, type RunEvent, run, type Scope, secret, snapshotError } from '@floway-dev/pipeline';
import { doneFrame, eventFrame } from '@floway-dev/protocols/common';
import type { OpenAIEmbeddingsPayload } from '@floway-dev/protocols/openai-embeddings';
import type { ProtocolOutcome, ProviderBaseOutput, ProviderFrame, ProviderInput, ProviderOpenAIEmbeddingsOutput } from '@floway-dev/provider';

vi.mock('../../../src/runtime/runtime-info.ts', () => ({ getRuntimeLocation: () => 'LOCAL' }));

const apiKey: ApiKey = {
  id: 'key', userId: 1, name: 'test', key: 'secret', serverSecret: '00'.repeat(32),
  createdAt: '2026-01-01', upstreamIds: null, randomizeUpstreams: false, deletedAt: null,
  dumpRetentionSeconds: null, openaiResponsesRetentionSeconds: 0,
};

const candidate = (variant: string): RouteCandidate => ({
  upstreamId: 'upstream', upstreamName: 'Upstream', kind: 'custom', modelId: 'public', upstreamModelId: variant,
  upstream: { id: 'upstream', name: 'Upstream', kind: 'custom', config: { baseUrl: 'https://upstream.test', apiKey: secret('key'), ingressHeadersRules: [] } },
  endpoints: {}, limits: {},
  providerModel: {
    id: 'public', kind: 'chat', upstreamModelId: variant, endpoints: {}, limits: {},
    enabledFlags: [], opaqueBlobCompatibilityScope: { bindToUpstream: true },
  },
});

const request = {
  'request.http': { method: 'POST', url: { origin: 'https://floway.test', pathname: '/v1/test' }, headers: [], body: null },
  'request.auth.apiKeyId': apiKey.id,
  'request.auth.user': { id: 1, isAdmin: true },
  'request.route.runtimeLocation': 'LOCAL',
  'request.route.randomizeUpstreams': false,
  'request.route.upstreamIds': null,
  'request.startedAt': 0,
} satisfies GatewayHttpFacts;

test.each(['usage', 'lastUsedAt'] as const)('reports each $0 failure separately for direct writes', async failing => {
  const failure = new Error(`${failing} unavailable`);
  const writeUsage = vi.fn(async () => { if (failing === 'usage') throw failure; });
  const touchKey = vi.fn(async () => { if (failing === 'lastUsedAt') throw failure; });
  const store = createUsageStore(writeUsage, touchKey);
  const row: UsageRecord = {
    keyId: apiKey.id, model: 'public', upstream: 'upstream', modelKey: 'wire-key', hour: '2026-01-01T00', pricingSelector: {}, requests: 1, metrics: [],
  };
  const receipts = await Promise.all([store.record(row), store.record(row)]);
  for (const receipt of receipts) {
    expect(receipt[failing]).toMatchObject({ error: { name: failure.name, message: failure.message } });
    expect(receipt[failing === 'usage' ? 'lastUsedAt' : 'usage']).toBe('written');
  }
  expect(writeUsage.mock.calls).toEqual([[row], [row]]);
  expect(touchKey.mock.calls).toEqual([[row.keyId], [row.keyId]]);
});

const testKey = 'response.test';
type Event = { readonly kind: 'output' | 'failure'; readonly tokens: number };
type Reply = ProviderBaseOutput & { readonly [testKey]: ProtocolOutcome<Event, number> };
type Attempt = (candidate: RouteCandidate, scope: Scope) => Reply;
const replyKeys = ['response.http', 'response.modelKey', testKey] as const;

const endpoint = (attempt: Attempt) => defineEnding<CandidateRequest, Reply>({
  name: 'upstream',
  request: { needs: ['route.candidate'] },
  return: { provides: replyKeys },
  execute: async (facts, scope) => attempt(facts['route.candidate'], scope),
});

const response = (model: RouteCandidate, http: Reply['response.http'], outcome: Reply[typeof testKey]): Reply => ({
  'response.http': http, 'response.modelKey': model.upstreamModelId, [testKey]: outcome,
});

const errorOutcome = (source: 'local' | 'upstream' = 'upstream'): Reply[typeof testKey] => ({ kind: 'error', source, error: 'failed' });
const tokenUsage = (output: number) => observedTokenUsage({ input: 5, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output });

const observe = createObserveCall<typeof testKey, Event, number>(testKey, {
  scalar: tokenUsage,
  open: () => {
    let output = 0;
    return {
      frame: frame => {
        if (frame.type === 'done') return;
        output = frame.event.tokens;
        return { output: frame.event.kind === 'output', failed: frame.event.kind === 'failure' };
      },
      usage: () => tokenUsage(output),
    };
  },
});

const runOptions = { finalizationTimeoutMs: 1_000 };
const metering = () => ({
  usageStore: { record: vi.fn<GatewayServices['usageStore']['record']>(async () => ({ usage: 'written', lastUsedAt: 'written' })) },
  performanceStore: { record: vi.fn<GatewayServices['performanceStore']['record']>(async () => {}) },
});

test('non-chat ingress defers stale refreshes and meters each provider response', async () => {
  type Payload = Omit<OpenAIEmbeddingsPayload, 'model'>;
  type ProviderRequest = ProviderInput<Extract<UpstreamFacts, { kind: 'custom' }>, Payload>;
  const providerExit = ['response.http', 'response.modelKey', 'response.openaiEmbeddings'] as const;
  const provider = compose<ProviderRequest & ProviderOpenAIEmbeddingsOutput>()('test.embeddings-provider', {
    entry: ['provider.upstream', 'provider.model', 'request.http', 'request.payload'],
    exit: providerExit,
    stages: [],
    ending: defineEnding<ProviderRequest, ProviderOpenAIEmbeddingsOutput>({
      name: 'respond',
      request: { needs: ['provider.model'] },
      return: { provides: providerExit },
      execute: async (facts, scope) => {
        const key = facts['provider.model'].upstreamModelId;
        const failed = key === 'loser';
        return {
          'response.http': jsonHttpResponse(failed ? 429 : 200, { model: key }, scope.clock()),
          'response.modelKey': key,
          'response.openaiEmbeddings': failed ? { kind: 'error', source: 'upstream', error: { model: key } } : { kind: 'ok' },
        };
      },
    }),
  });
  const candidates = ['loser', 'winner'].map(candidate);
  const staleRefreshes = [{ upstreamId: 'stale', configVersion: 1, inputHash: 'v1' }];
  const services = {
    ...createGatewayServices({ apiKey, runtimeLocation: 'LOCAL' }),
    ...metering(),
    providers: { enumerate: async () => ({ candidates, sawModel: true, failedUpstreams: [], staleRefreshes }) },
    modelsRefresh: vi.fn<GatewayServices['modelsRefresh']>(async () => ({ refreshed: true })),
  };
  const pipeline = createNonChatPipeline({
    name: 'test.embeddings', sourceApi: '/embeddings', kind: 'embedding', operation: 'embeddings',
    outcomeKey: 'response.openaiEmbeddings', targets: { custom: provider },
    parse: http => {
      const parsed = parseJsonModel(http, 'Embeddings');
      return 'error' in parsed ? parsed : { model: parsed.model, payload: { input: 'text' } };
    },
    select: candidates => candidates,
    respond: (response, _request, identity, scope) => scalarHttpAttempt(scope, response['response.http'], identity),
  });
  const handle = run(pipeline, { ...request, 'request.http': { ...request['request.http'], body: Bytes.fromUtf8('{"model":"public"}') } }, {
    ...runOptions, services,
  });
  const output = await handle.result;
  expect(Object.keys(output).sort()).toEqual(['response.delivery', 'response.http', 'response.render']);
  expect(await writeHttpResponse(output['response.http']).json()).toEqual({ model: 'winner' });
  expect(await handle.done).toEqual({ ok: true });
  expect(services.modelsRefresh).toHaveBeenCalledExactlyOnceWith(staleRefreshes[0]);
  expect(services.usageStore.record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ modelKey: 'winner' }));
  expect(services.performanceStore.record.mock.calls).toEqual([
    [expect.objectContaining({ kind: 'zero-output-error' })],
    [expect.objectContaining({ kind: 'neutral' })],
  ]);
});

test.each([true, false])('chat rendering turns a transport frame into a response when stream is %s', async stream => {
  const fault = snapshotError(new Error('socket reset'));
  type Input = DeliveryFacts;
  type Output = HttpOutput & ChatOutcomeFacts<'openaiChatCompletions', Event>;
  const outcomeKey = 'response.openaiChatCompletions';
  const encoder = createEncode<'openaiChatCompletions', Input['request.delivery'], Event>('openaiChatCompletions', {
    async encodeJson(source) {
      for await (const _frame of source) { /* drain */ }
      return {};
    },
    openSse: () => ({
      encode: () => ({ wire: 'data: output\n\n' }),
      eof: () => ({ type: 'completed' }),
      failure: error => [`data: ${String(error)}\n\n`],
    }),
  });
  const pipeline = compose<Input & Output & RenderFacts>()('test.chat-transport', {
    entry: ['request.delivery'],
    exit: ['response.http', 'response.render'],
    stages: [encoder],
    ending: defineEnding<Input, Output>({
      name: 'provider', request: { needs: [] }, return: { provides: ['response.http', outcomeKey] },
      execute: async (_facts, scope) => ({
        'response.http': { ...jsonHttpResponse(200, null, 0), body: null },
        [outcomeKey]: {
          kind: 'stream',
          events: scope.createStream<ProviderFrame<Event>>({
            label: 'provider events',
            async *iterate() {
              yield eventFrame({ kind: 'output', tokens: 1 });
              yield { type: 'transport-error', error: fault };
            },
          }),
        },
      }),
    }),
  });
  const handle = run(pipeline, { 'request.delivery': { stream } }, { ...runOptions, services: {} });
  const output = await handle.result;
  const http = writeHttpResponse(output['response.http']);
  expect(http.status).toBe(stream ? 200 : 502);
  expect(await http.text()).toContain('socket reset');
  await expect(output['response.render'].promise).resolves.toEqual({
    kind: 'failed', reason: stream ? 'source-error' : 'collect-error', error: fault,
  });
  await expect(handle.done).resolves.toEqual({ ok: true });
});

test('failover records each contacted upstream and releases the unselected error body', async () => {
  type Space = GatewayHttpFacts & CandidatesRequest & Reply;
  const services = metering();
  const released = vi.fn();
  const pipeline = compose<Space, typeof services>()('test.per-call', {
    entry: [...GATEWAY_HTTP_ENTRY, 'route.candidates'],
    exit: replyKeys,
    stages: [createFailover(testKey), recordCall('chat'), priceCall, observe],
    ending: endpoint((model, scope) => {
      if (model.upstreamModelId === 'winner') return response(model, jsonHttpResponse(200, {}, 10), { kind: 'result', result: 3 });
      const body = scope.createStream({ label: 'discarded body', async *iterate() { yield Bytes.fromUtf8('loser'); }, onClose: released });
      return response(model, { ...jsonHttpResponse(429, {}, 10), body }, errorOutcome());
    }),
  });
  const events: RunEvent[] = [];
  const handle = run(pipeline, { ...request, 'route.candidates': ['loser', 'winner'].map(candidate) }, {
    ...runOptions, services, events: event => events.push(event),
  });
  expect(await handle.result).toMatchObject({ [testKey]: { kind: 'result', result: 3 } });
  expect(await handle.done).toEqual({ ok: true });
  expect(released).toHaveBeenCalledWith({ how: 'released' });
  expect(services.usageStore.record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ modelKey: 'winner', requests: 1 }));
  expect(services.performanceStore.record.mock.calls).toEqual([
    [expect.objectContaining({ kind: 'zero-output-error' })],
    [expect.objectContaining({ kind: 'neutral' })],
  ]);
  const records = new Set(events.flatMap(event => event.k === 'deferred' && event.name === 'call.record' ? [event.deferredId] : []));
  expect(events.filter(event => event.k === 'settled' && records.has(event.deferredId))).toEqual([
    expect.objectContaining({ ok: true, value: expect.objectContaining({ status: 429, failed: true, persisted: true }) }),
    expect.objectContaining({ ok: true, value: expect.objectContaining({ status: 200, failed: false, persisted: true }) }),
  ]);
});

test.each([
  { source: 'local', status: 400, performance: [] },
  { source: 'upstream', status: 429, performance: [[expect.objectContaining({ kind: 'zero-output-error' })]] },
] as const)('an unmetered $source error records only contacted upstream performance', async ({ source, status, performance }) => {
  const services = metering();
  const pipeline = compose<GatewayHttpFacts & CandidateRequest & Reply, typeof services>()('test.error-metering', {
    entry: [...GATEWAY_HTTP_ENTRY, 'route.candidate'],
    exit: replyKeys,
    stages: [recordCall('chat'), priceCall, observe],
    ending: endpoint(model => response(model, jsonHttpResponse(status, {}, 10), errorOutcome(source))),
  });
  const handle = run(pipeline, { ...request, 'route.candidate': candidate('error') }, { ...runOptions, services });
  expect((await handle.result)['response.http'].status).toBe(status);
  expect(await handle.done).toEqual({ ok: true });
  expect(services.usageStore.record).not.toHaveBeenCalled();
  expect(services.performanceStore.record.mock.calls).toEqual(performance);
});

test.each([
  { end: 'terminal', expected: [[expect.objectContaining({ kind: 'sample', sample: expect.objectContaining({ success: true }) })]] },
  { end: 'protocol-error', expected: [[expect.objectContaining({ kind: 'sample', sample: expect.objectContaining({ success: false }) })]] },
  { end: 'transport-error', expected: [[expect.objectContaining({ kind: 'sample', sample: expect.objectContaining({ success: false }) })]] },
  { end: 'premature-eof', expected: [[expect.objectContaining({ kind: 'sample', sample: expect.objectContaining({ success: false }) })]] },
  { end: 'released', expected: [] },
  { end: 'panic', expected: [] },
] as const)('stream end $end settles performance and observed usage', async ({ end, expected }) => {
  const services = metering();
  const failure = new Error('test stream interrupted');
  const pipeline = compose<GatewayHttpFacts & CandidateRequest & Reply, typeof services>()('test.stream-metering', {
    entry: [...GATEWAY_HTTP_ENTRY, 'route.candidate'],
    exit: replyKeys,
    stages: [recordCall('chat'), priceCall, observe],
    ending: endpoint((model, scope) => {
      const http = { ...jsonHttpResponse(200, {}, 0), body: null };
      return response(model, http, {
        kind: 'stream',
        events: scope.createStream<ProviderFrame<Event>>({
          label: 'attempt events',
          async *iterate() {
            yield eventFrame({ kind: 'output', tokens: 3 });
            if (end === 'terminal') yield doneFrame();
            if (end === 'protocol-error') yield eventFrame({ kind: 'failure', tokens: 3 });
            if (end === 'transport-error') yield { type: 'transport-error', error: snapshotError(failure) };
            if (end === 'panic') throw failure;
          },
        }),
      });
    }),
  });
  const handle = run(pipeline, { ...request, 'route.candidate': candidate(end) }, { ...runOptions, services });
  const outcome = (await handle.result)[testKey];
  if (outcome.kind !== 'stream') throw new Error('Expected stream outcome');
  const frames = outcome.events[Symbol.asyncIterator]();
  expect(await frames.next()).toMatchObject({ value: { type: 'event' } });
  if (end === 'panic') {
    await expect(frames.next()).rejects.toBe(failure);
  } else if (end === 'released') {
    await frames.return?.();
  } else if (end === 'premature-eof') {
    expect(await frames.next()).toMatchObject({ done: true });
  } else {
    expect(await frames.next()).toMatchObject({ done: false });
    await frames.return?.();
  }
  expect(await handle.done).toMatchObject({ ok: end !== 'panic' });
  expect(services.usageStore.record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    modelKey: end, metrics: expect.arrayContaining([expect.objectContaining({ metric: 'output_tokens', quantity: '3' })]),
  }));
  expect(services.performanceStore.record.mock.calls).toEqual(expected);
});

test.each([
  { attempts: ['30', 'transport', '4', '20', 'transport'], winner: '4' },
  { attempts: ['invalid date', 'transport'], winner: 'transport' },
  { attempts: ['transport', 'invalid date'], winner: 'invalid date' },
])('failover selects $winner from $attempts', async ({ attempts, winner }) => {
  const visited: string[] = [];
  const pipeline = compose<CandidatesRequest & Reply>()('test.retries', {
    entry: ['route.candidates'],
    exit: replyKeys,
    stages: [createFailover(testKey)],
    ending: endpoint((model, scope) => {
      const variant = model.upstreamModelId;
      visited.push(variant);
      const http = variant === 'transport'
        ? { ...jsonHttpResponse(502, null, scope.clock()), body: null, transportError: snapshotError(new Error('dial failed')) }
        : { ...jsonHttpResponse(429, {}, scope.clock()), headers: [['retry-after', variant]] as const };
      return response(model, http, errorOutcome());
    }),
  });
  const handle = run(pipeline, { 'route.candidates': attempts.map(candidate) }, { ...runOptions, services: {} });
  expect((await handle.result)['response.modelKey']).toBe(winner);
  expect(visited).toEqual(attempts);
  expect(await handle.done).toEqual({ ok: true });
});

test('failover returns a successful body before reading any bytes', async () => {
  const pull = vi.fn();
  const pipeline = compose<CandidatesRequest & Reply>()('test.unread-body', {
    entry: ['route.candidates'],
    exit: replyKeys,
    stages: [createFailover(testKey)],
    ending: endpoint((model, scope) => {
      const body = scope.createStream({
        label: 'successful upstream body',
        async *iterate() {
          pull();
          yield Bytes.fromUtf8('answer');
        },
      });
      return response(model, { ...jsonHttpResponse(200, {}, 10), body }, { kind: 'result', result: 3 });
    }),
  });
  const handle = run(pipeline, { 'route.candidates': [candidate('winner')] }, { ...runOptions, services: {} });
  const { 'response.http': { body } } = await handle.result;
  expect(pull).not.toHaveBeenCalled();
  if (body === null || body instanceof Bytes) throw new Error('Expected the managed upstream body');
  const received: Bytes[] = [];
  for await (const chunk of body) {
    if (isTransportFailure(chunk)) throw new Error('Unexpected upstream failure');
    received.push(chunk);
  }
  expect(Bytes.concat(received).utf8()).toBe('answer');
  expect(pull).toHaveBeenCalledExactlyOnceWith();
  expect(await handle.done).toEqual({ ok: true });
});

test('the host schedules run completion and a panic stops failover before the next candidate', async () => {
  const failure = new Error('test crash');
  const called = vi.fn(() => { throw failure; });
  const pipeline = compose<HttpInput & CandidatesRequest & Reply & HttpDeliveryFacts>()('test.crash', {
    entry: ['request.http', 'route.candidates'],
    exit: [...replyKeys, 'response.delivery'],
    stages: [edgeHttp, createFailover(testKey)],
    ending: endpoint(called),
  });
  const scheduler = vi.fn();
  const events: RunEvent[] = [];
  const handle = startGatewayRun(pipeline, { ...request, 'route.candidates': ['panic', 'unvisited'].map(candidate) }, {
    apiKey, request: request['request.http'], services: {}, scheduler, events: event => events.push(event),
  });
  expect(scheduler).toHaveBeenCalledExactlyOnceWith(handle.done);
  await expect(handle.result).rejects.toBe(failure);
  expect(await handle.done).toMatchObject({ ok: false });
  expect(called).toHaveBeenCalledOnce();
  expect(events).toContainEqual(expect.objectContaining({ k: 'fail', error: expect.objectContaining({ message: 'test crash' }) }));
});

test('the ingress strips Floway authentication and preserves other request headers', async () => {
  const http = {
    ...request['request.http'], headers: [
      ['Authorization', secret('floway-key')], ['X-API-Key', secret('floway-key')], ['x-goog-api-key', secret('floway-key')],
      ['x-floway-session', secret('floway-session')], ['X-Vendor', 'value'],
    ] as const,
  };
  const seen = vi.fn();
  const pipeline = compose<HttpInput & HttpOutput>()('test.strip-auth', {
    entry: ['request.http'],
    exit: ['response.http'],
    stages: [stripFlowayAuth],
    ending: defineEnding<HttpInput, HttpOutput>({
      name: 'inspect',
      request: { needs: ['request.http'] },
      return: { provides: ['response.http'] },
      execute: async (facts, scope) => {
        seen(facts['request.http']);
        return { 'response.http': jsonHttpResponse(200, null, scope.clock()) };
      },
    }),
  });
  const handle = run(pipeline, { 'request.http': http }, { ...runOptions, services: {} });
  await handle.result;
  expect(await handle.done).toEqual({ ok: true });
  expect(seen).toHaveBeenCalledExactlyOnceWith({ ...http, headers: [['X-Vendor', 'value']] });
});

test.each([
  { failure: new Error('test crash'), status: 500 },
  { failure: new UpstreamTransportError(new Error('test broken socket')), status: 502 },
])('the HTTP host renders status $status with the original stack', async ({ failure, status }) => {
  initBackgroundSchedulerResolver(() => () => {});
  const pipeline = compose<GatewayHttpFacts & HttpOutput>()('test.host', {
    entry: GATEWAY_HTTP_ENTRY,
    exit: ['response.http'],
    stages: [edgeHttp],
    ending: defineEnding<GatewayHttpFacts, HttpOutput>({
      name: 'crash', request: { needs: [] }, return: { provides: ['response.http'] },
      execute: async () => { throw failure; },
    }),
  });
  const app = new Hono<{ Variables: AuthVars }>()
    .use('*', async (context, next) => {
      context.set('apiKey', apiKey);
      context.set('user', { id: 1, isAdmin: true, username: '', passwordHash: null, createdAt: '2026-01-01', deletedAt: null });
      await next();
    })
    .post('/v1/test', createGatewayHttpHandler(pipeline));
  const result = await app.request('/v1/test', { method: 'POST' });
  expect(result.status).toBe(status);
  expect(await result.json()).toMatchObject({ error: { name: failure.name, message: failure.message, stack: failure.stack } });
});
