import { Hono } from 'hono';
import { expect, test, vi } from 'vitest';

import { type AnswerSource, answerKeys, gatewayAnswer } from '../../../src/data-plane/pipeline/answer.ts';
import { edgeHttp, type HttpInput, type HttpOutput, jsonHttpResponse } from '../../../src/data-plane/pipeline/edge-http.ts';
import { type AttemptResponse, type CandidateRequest, type CandidatesRequest, failover } from '../../../src/data-plane/pipeline/failover.ts';
import { createGatewayHttpHandler, type GatewayHttpFacts, startGatewayRun } from '../../../src/data-plane/pipeline/host.ts';
import { billableCall, type BillableCall, observedTokenUsage, observeIdentity, scalarUsageFacts } from '../../../src/data-plane/pipeline/observe-usage.ts';
import { failedRender, renderedNow, type RenderFacts, type RenderOutcome } from '../../../src/data-plane/pipeline/render.ts';
import type { GatewayServices, RouteCandidate } from '../../../src/data-plane/pipeline/services.ts';
import { priceUsage, type SettlementFacts, writeSettlement } from '../../../src/data-plane/pipeline/settlement.ts';
import { UpstreamTransportError } from '../../../src/dial/transport-error.ts';
import type { AuthVars } from '../../../src/middleware/auth.ts';
import type { ApiKey } from '../../../src/repo/types.ts';
import { initBackgroundSchedulerResolver } from '../../../src/runtime/background.ts';
import { Bytes, compose, defineEnding, defineStage, type RunEvent, run, type StageEnv } from '@floway-dev/pipeline';

vi.mock('../../../src/data-plane/providers/registry.ts', () => ({}));
vi.mock('../../../src/runtime/runtime-info.ts', () => ({ getRuntimeLocation: () => 'LOCAL' }));

const apiKey: ApiKey = {
  id: 'key', userId: 1, name: 'test', key: 'secret', serverSecret: '00'.repeat(32),
  createdAt: '2026-01-01', upstreamIds: null, randomizeUpstreams: false, deletedAt: null,
  dumpRetentionSeconds: null, openaiResponsesRetentionSeconds: 0,
};

const candidate = (variant: string): RouteCandidate => ({
  upstreamId: 'upstream', upstreamName: 'Upstream', kind: 'custom', modelId: 'public', upstreamModelId: variant,
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
} satisfies GatewayHttpFacts;

type RenderedAttempt = AttemptResponse & RenderFacts;
type Attempt = (candidate: RouteCandidate, env: StageEnv) => RenderedAttempt;
const endpoint = (attempt: Attempt, provides: readonly string[] = []) => defineEnding<CandidateRequest, RenderedAttempt>({
  name: 'upstream',
  request: { needs: ['route.candidate'] },
  return: { provides: [...answerKeys, ...provides] },
  execute: async (facts, _into, env) => attempt(facts['route.candidate'], env),
});

const counted = (
  model: RouteCandidate, env: StageEnv, status: number, output: number,
  disposition: BillableCall['disposition'] = status === 200 ? 'completed' : 'api-error', render: RenderOutcome = { kind: 'completed' }, source: AnswerSource = 'upstream',
): RenderedAttempt => ({
  ...scalarUsageFacts(env, billableCall(env, observeIdentity(model, model.upstreamModelId), disposition,
    observedTokenUsage({ input: 5, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output }))),
  ...renderedNow(env, render),
  'response.http': jsonHttpResponse(status, { variant: model.upstreamModelId }, 10),
  'response.source': source,
});

test.each([200, 429])('scalar HTTP %s bills one accepted call and skips an unmetered API error', async status => {
  const pipeline = compose<CandidateRequest, RenderedAttempt, {}>('test.unmetered', {
    stages: [],
    ending: endpoint((model, env) => ({
      ...scalarUsageFacts(env, billableCall(env, observeIdentity(model, model.upstreamModelId), status === 200 ? 'completed' : 'api-error', observedTokenUsage(null))),
      ...renderedNow(env, { kind: 'completed' }),
      'response.http': jsonHttpResponse(status, {}, env.clock()),
      'response.source': 'upstream',
    })),
  });
  const handle = run(pipeline, { 'route.candidate': candidate('unmetered') }, { services: {}, finalizationTimeoutMs: 100 });
  const response = await handle.result;
  expect(await response['response.usage.billable'].promise).toEqual(status === 200 ? [expect.objectContaining({ usage: null })] : []);
  expect(await handle.done).toEqual({ ok: true });
});

test('a rejected losing billing deferred fails done while the winner settles usage and performance', async () => {
  const usageStore = { record: vi.fn(async () => {}) };
  const performanceStore = { record: vi.fn(async () => {}) };
  const services = { usageStore, performanceStore };
  const lost = new Error('original losing billing error');
  const pipeline = compose<GatewayHttpFacts & CandidatesRequest, HttpOutput & SettlementFacts, typeof services>('test.lose-billing', {
    stages: [writeSettlement('chat'), priceUsage, edgeHttp, failover],
    ending: endpoint((model, env) => {
      if (model.upstreamModelId === 'winner') return counted(model, env, 200, 3);
      return {
        ...counted(model, env, 429, 0),
        'response.usage.billable': env.defer('losing call', Promise.reject(lost)),
      };
    }),
  });
  const handle = run(pipeline, { ...request, 'route.candidates': [candidate('loser'), candidate('winner')] }, { services, finalizationTimeoutMs: 100 });
  const response = await handle.result;
  expect(response['response.http'].status).toBe(200);
  expect(await response['response.settlement'].promise).toMatchObject({ outcome: 'success' });
  expect(await handle.done).toMatchObject({ ok: false, error: { message: lost.message } });
  expect(usageStore.record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ modelKey: 'winner', requests: 1 }));
  expect(performanceStore.record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'neutral' }));
});

test.each([false, true])('the host writes each observed billable call once (outer throw %s)', async shouldThrow => {
  const usageStore = { record: vi.fn(async () => {}) };
  const performanceStore = { record: vi.fn(async () => {}) };
  const services = { usageStore, performanceStore };
  type Input = GatewayHttpFacts & CandidatesRequest;
  const failure = new Error('failed after observing the selected call');
  const render = defineStage<Input, Input, RenderedAttempt, RenderedAttempt>({
    name: 'render',
    through: {
      request: { needs: [], consumes: [], provides: [] },
      response: { needs: ['response.http'], consumes: [], provides: [] },
    },
    execute: async (facts, next) => {
      const response = await next(facts);
      if (shouldThrow) throw failure;
      return response;
    },
  });
  const pipeline = compose<Input, HttpOutput & SettlementFacts, typeof services>('test.sweep', {
    stages: [writeSettlement('chat'), priceUsage, edgeHttp, render, failover],
    ending: endpoint((model, env) => counted(model, env, 200, 3)),
  });
  const tasks: Promise<unknown>[] = [];
  const handle = startGatewayRun(pipeline, { ...request, 'route.candidates': [candidate('selected')] }, {
    apiKey, request: request['request.http'], services, scheduler: task => tasks.push(task),
  });
  if (shouldThrow) await expect(handle.result).rejects.toBe(failure);
  else expect((await handle.result)['response.http'].status).toBe(200);
  expect(await handle.done).toMatchObject({ ok: !shouldThrow });
  expect(tasks).toContain(handle.done);
  await Promise.all(tasks);
  expect(usageStore.record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ modelKey: 'selected', requests: 1 }));
  expect(performanceStore.record).toHaveBeenCalledTimes(shouldThrow ? 0 : 1);
});

test('a pending settlement usage write still owns the call after finalization times out', async () => {
  const pendingWrite = Promise.withResolvers<void>();
  const usageStore = { record: vi.fn(async () => {}).mockImplementationOnce(() => pendingWrite.promise) };
  const services = { usageStore, performanceStore: { record: async () => {} } };
  type Input = GatewayHttpFacts & CandidatesRequest;
  const pipeline = compose<Input, HttpOutput & SettlementFacts, typeof services>('test.usage-ownership', {
    stages: [writeSettlement('chat'), priceUsage, edgeHttp, failover],
    ending: endpoint((model, env) => counted(model, env, 200, 3)),
  });
  const tasks: Promise<unknown>[] = [];
  const handle = startGatewayRun(pipeline, { ...request, 'route.candidates': [candidate('selected')] }, {
    apiKey, request: request['request.http'], services, scheduler: task => tasks.push(task), finalizationTimeoutMs: 20,
  });
  try {
    expect((await handle.result)['response.http'].status).toBe(200);
    expect(await handle.done).toMatchObject({ ok: false, error: { name: 'FinalizationTimeoutError' } });
    await Promise.all(tasks);
    expect(usageStore.record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ modelKey: 'selected', requests: 1 }));
  } finally {
    pendingWrite.resolve();
  }
});

test('the billing sweep honors a sub-run settlement that never reached the root', async () => {
  const usageStore = { record: vi.fn(async () => {}) };
  const services = { usageStore, performanceStore: { record: vi.fn(async () => {}) } };
  type Input = GatewayHttpFacts & CandidatesRequest;
  const sub = compose<Input, HttpOutput & SettlementFacts, typeof services>('test.usage-sub-run', {
    stages: [writeSettlement(null), priceUsage, edgeHttp, failover],
    ending: endpoint((model, env) => counted(model, env, 200, 3)),
  });
  const root = compose<Input, HttpOutput, typeof services>('test.parent-run', {
    stages: [],
    ending: defineEnding<Input, HttpOutput, {}, typeof services>({
      name: 'invoke',
      request: { needs: ['request.http', 'route.candidates'] },
      return: { provides: ['response.http'] },
      execute: async (facts, _into, env) => ({ 'response.http': (await env.run(sub, facts).result)['response.http'] }),
    }),
  });
  const tasks: Promise<unknown>[] = [];
  const handle = startGatewayRun(root, { ...request, 'route.candidates': [candidate('sub-run')] }, {
    apiKey, request: request['request.http'], services, scheduler: task => tasks.push(task),
  });
  expect((await handle.result)['response.http'].status).toBe(200);
  expect(await handle.done).toEqual({ ok: true });
  await Promise.all(tasks);
  expect(usageStore.record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ modelKey: 'sub-run', requests: 1 }));
});

test('crash attribution keeps the deepest candidate on the last failing sibling chain', async () => {
  const failure = new Error('upstream failed');
  const outer = { ...candidate('outer'), modelId: 'outer' };
  const first = { ...candidate('first'), modelId: 'first' };
  const deepest = { ...candidate('deep'), modelId: 'deep' };
  const fork = defineStage<CandidateRequest, CandidateRequest, RenderedAttempt, RenderedAttempt>({
    name: 'fork',
    through: {
      request: { needs: ['route.candidate'], consumes: [], provides: ['route.candidate'] },
      response: { needs: [], consumes: [], provides: [] },
    },
    execute: async (facts, next) => {
      await expect(next({ ...facts, 'route.candidate': first })).rejects.toBe(failure);
      return await next({ ...facts, 'route.candidate': deepest });
    },
  });
  const pipeline = compose<CandidateRequest, HttpOutput, {}>('test.crash-candidate', {
    stages: [fork],
    ending: endpoint(() => { throw failure; }),
  });
  const tasks: Promise<unknown>[] = [];
  const store = { record: vi.fn(async () => {}) };
  const handle = startGatewayRun(pipeline, { 'route.candidate': outer }, {
    apiKey, request: request['request.http'], services: {}, scheduler: task => tasks.push(task),
    crashPerformance: { route: request, operation: 'chat', store },
  });
  await expect(handle.result).rejects.toBe(failure);
  expect(await handle.done).toMatchObject({ ok: false });
  await Promise.all(tasks);
  expect(store.record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    kind: 'zero-output-error', dimensions: expect.objectContaining({ model: 'deep', upstream: 'upstream' }),
  }));
});

test.each([
  { disposition: 'completed', render: failedRender('premature-eof', new Error('source frames ended')), status: 200, source: 'upstream', outcome: 'failed', record: { kind: 'sample', sample: { success: false } } },
  { disposition: 'stream-error', render: { kind: 'completed' }, status: 200, source: 'upstream', outcome: 'success', record: { kind: 'sample', sample: { success: true } } },
  { disposition: 'completed', render: failedRender('collect-error', new Error('response collection failed')), status: 502, source: 'upstream', outcome: 'failed', record: { kind: 'zero-output-error' } },
  { disposition: 'api-error', render: { kind: 'completed' }, status: 429, source: 'upstream', outcome: 'upstream-error', record: { kind: 'zero-output-error' } },
  { disposition: 'api-error', render: { kind: 'completed' }, status: 400, source: 'gateway', outcome: 'gateway-error', record: { kind: 'zero-output-error' } },
] as const)('settlement classifies $outcome from render and answer source', async ({ disposition, render, status, source, outcome, record }) => {
  const usageStore = { record: vi.fn(async () => {}) };
  const performanceStore = { record: vi.fn<GatewayServices['performanceStore']['record']>(async () => {}) };
  const services = { usageStore, performanceStore };
  const pipeline = compose<GatewayHttpFacts & CandidatesRequest, HttpOutput & SettlementFacts, typeof services>('test.render-settlement', {
    stages: [writeSettlement('chat'), priceUsage, edgeHttp, failover],
    ending: endpoint((model, env) => ({
      ...counted(model, env, status, 3, disposition, render, source),
      'response.timing.firstOutputAt': env.defer('ttft', Promise.resolve(disposition === 'api-error' ? null : 20)),
      'response.timing.streamEndedAt': env.defer('end', Promise.resolve(disposition === 'api-error' ? null : 50)),
    })),
  });
  const handle = run(pipeline, { ...request, 'route.candidates': [candidate('selected')] }, { services, finalizationTimeoutMs: 100 });
  const response = await handle.result;
  expect(response['response.http'].status).toBe(status);
  expect(await response['response.settlement'].promise).toMatchObject({ outcome, status });
  expect(await handle.done).toEqual({ ok: true });
  expect(performanceStore.record).toHaveBeenCalledOnce();
  expect(performanceStore.record.mock.calls[0]?.[0]).toMatchObject(record);
  expect(usageStore.record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ requests: 1 }));
});

test('a gateway answer can override a disabled performance operation', async () => {
  const services = { usageStore: { record: vi.fn(async () => {}) }, performanceStore: { record: vi.fn(async () => {}) } };
  const pipeline = compose<GatewayHttpFacts & CandidatesRequest, HttpOutput & SettlementFacts, typeof services>('test.operation-override', {
    stages: [writeSettlement(null), priceUsage, edgeHttp, failover],
    ending: endpoint((_model, env) => gatewayAnswer(env, jsonHttpResponse(400, { error: 'invalid input' }, 0), {
      'response.performance.operation': 'chat' as const,
    }), ['response.performance.operation']),
  });
  const handle = run(pipeline, { ...request, 'route.candidates': [candidate('selected')] }, { services, finalizationTimeoutMs: 100 });
  const response = await handle.result;
  expect(await response['response.settlement'].promise).toMatchObject({ outcome: 'gateway-error' });
  expect(await handle.done).toEqual({ ok: true });
  expect(services.usageStore.record).not.toHaveBeenCalled();
  expect(services.performanceStore.record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    kind: 'zero-output-error', dimensions: expect.objectContaining({ operation: 'chat' }),
  }));
});

test.each([
  { render: { kind: 'completed' }, outcome: 'success', performance: 'neutral' },
  { render: { kind: 'cancelled' }, outcome: 'failed', performance: 'zero-output-error' },
] as const)('client-cancelled delivery after $render.kind render settles as $outcome', async ({ render, outcome, performance }) => {
  const services = { usageStore: { record: vi.fn(async () => {}) }, performanceStore: { record: vi.fn(async () => {}) } };
  const pipeline = compose<GatewayHttpFacts & CandidatesRequest, HttpOutput & SettlementFacts, typeof services>('test.delivery-settlement', {
    stages: [writeSettlement('chat'), priceUsage, edgeHttp, failover],
    ending: endpoint((model, env) => {
      const result = counted(model, env, 200, 0, 'completed', render);
      const body = env.createStream({ label: 'unread body', async *iterate() { yield Bytes.fromUtf8('answer'); } });
      return { ...result, 'response.http': { ...result['response.http'], body } };
    }),
  });
  const handle = run(pipeline, { ...request, 'route.candidates': [candidate('selected')] }, { services, finalizationTimeoutMs: 100 });
  const response = await handle.result;
  const { body } = response['response.http'];
  if (body === null || body instanceof Bytes) throw new Error('Expected the managed downstream body');
  await body.close();
  expect(await response['response.settlement'].promise).toMatchObject({ outcome });
  expect(await handle.done).toEqual({ ok: true });
  expect(services.performanceStore.record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: performance }));
});

test('settlement bills losing attempts and samples only the selected attempt even when identities match', async () => {
  const usageStore = { record: vi.fn(async () => {}) };
  const performanceStore = { record: vi.fn(async () => {}) };
  const services = { usageStore, performanceStore };
  const released = vi.fn();
  const pipeline = compose<GatewayHttpFacts & CandidatesRequest, HttpOutput & SettlementFacts, typeof services>('test.usage', {
    stages: [writeSettlement('chat'), priceUsage, edgeHttp, failover],
    ending: endpoint((model, env) => {
      const winner = model.upstreamModelId === 'winner';
      const result = counted(model, env, winner ? 200 : 429, winner ? 3 : 99);
      if (winner) {
        return { ...result, 'response.timing.firstOutputAt': env.defer('ttft', Promise.resolve(20)), 'response.timing.streamEndedAt': env.defer('end', Promise.resolve(50)) };
      }
      const body = env.createStream({ label: 'discarded body', async *iterate() { yield Bytes.fromUtf8('loser'); }, onClose: released });
      return { ...result, 'response.http': { ...result['response.http'], body } };
    }),
  });

  const handle = run(pipeline, { ...request, 'route.candidates': [candidate('loser'), candidate('winner')] }, { services, finalizationTimeoutMs: 100 });
  expect((await handle.result)['response.http'].status).toBe(200);
  expect(await handle.done).toEqual({ ok: true });
  expect(released).toHaveBeenCalledWith({ how: 'released' });
  expect(usageStore.record.mock.calls).toEqual([
    [expect.objectContaining({ modelKey: 'loser', requests: 1, metrics: expect.arrayContaining([expect.objectContaining({ metric: 'output_tokens', quantity: '99' })]) })],
    [expect.objectContaining({ modelKey: 'winner', requests: 1, metrics: expect.arrayContaining([expect.objectContaining({ metric: 'output_tokens', quantity: '3' })]) })],
  ]);
  expect(performanceStore.record).toHaveBeenCalledExactlyOnceWith({ kind: 'sample', sample: expect.objectContaining({ ttftMs: 10, tpotUs: 15000, success: true }) });
});

test('failover retries transport failures and returns the earliest Retry-After response on exhaustion', async () => {
  const visited: string[] = [];
  const pipeline = compose<CandidatesRequest, HttpOutput, {}>('test.retries', {
    stages: [failover],
    ending: endpoint((model, env) => {
      const variant = model.upstreamModelId;
      visited.push(variant);
      if (variant === 'transport') throw new UpstreamTransportError(new Error('dial failed'));
      const result = counted(model, env, 429, 0);
      return { ...result, 'response.http': { ...result['response.http'], headers: [['retry-after', variant]] } };
    }),
  });
  const handle = run(pipeline, { 'route.candidates': ['30', 'transport', '4', '20', 'transport'].map(candidate) }, { services: {}, finalizationTimeoutMs: 100 });
  const response = (await handle.result)['response.http'];
  expect(response.headers).toEqual([['retry-after', '4']]);
  expect(visited).toEqual(['30', 'transport', '4', '20', 'transport']);
  expect(await handle.done).toEqual({ ok: true });
});

test('failover returns a successful body without reading any bytes', async () => {
  const pull = vi.fn();
  const pipeline = compose<CandidatesRequest, HttpOutput, {}>('test.unread-body', {
    stages: [failover],
    ending: endpoint((model, env) => {
      const result = counted(model, env, 200, 0);
      const body = env.createStream({
        label: 'successful upstream body',
        async *iterate() {
          pull();
          yield Bytes.fromUtf8('answer');
        },
      });
      return { ...result, 'response.http': { ...result['response.http'], body } };
    }),
  });
  const handle = run(pipeline, { 'route.candidates': [candidate('winner')] }, { services: {}, finalizationTimeoutMs: 100 });
  const { 'response.http': { body } } = await handle.result;
  expect(pull).not.toHaveBeenCalled();
  if (body === null || body instanceof Bytes) throw new Error('Expected the managed upstream body');
  const received: Bytes[] = [];
  for await (const chunk of body) received.push(chunk);
  expect(Bytes.concat(received).utf8()).toBe('answer');
  expect(pull).toHaveBeenCalledExactlyOnceWith();
  expect(await handle.done).toEqual({ ok: true });
});

test('the host schedules the exact run completion promise and edgeHttp leaves throws intact', async () => {
  const failure = new Error('test crash');
  const pipeline = compose<HttpInput, HttpOutput, {}>('test.crash', {
    stages: [edgeHttp],
    ending: defineEnding<HttpInput, HttpOutput>({
      name: 'crash', request: { needs: [] }, return: { provides: ['response.http'] },
      execute: async () => { throw failure; },
    }),
  });
  const scheduler = vi.fn();
  const events: RunEvent[] = [];
  const handle = startGatewayRun(pipeline, request, { apiKey, request: request['request.http'], services: {}, scheduler, events: event => events.push(event) });
  expect(scheduler).toHaveBeenCalledExactlyOnceWith(handle.done);
  await expect(handle.result).rejects.toBe(failure);
  expect(await handle.done).toMatchObject({ ok: false });
  expect(events).toContainEqual(expect.objectContaining({ k: 'fail', error: expect.objectContaining({ message: 'test crash' }) }));
});

test.each([
  { failure: new Error('test crash'), status: 500 },
  { failure: new UpstreamTransportError(new Error('test broken socket')), status: 502 },
])('the HTTP host renders status $status with the original stack', async ({ failure, status }) => {
  initBackgroundSchedulerResolver(() => () => {});
  const pipeline = compose<GatewayHttpFacts, HttpOutput, {}>('test.host', {
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
  const response = await app.request('/v1/test', { method: 'POST' });
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ error: { name: failure.name, message: failure.message, stack: failure.stack } });
});
