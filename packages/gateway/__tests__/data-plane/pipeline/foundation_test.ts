import { Hono } from 'hono';
import { expect, test, vi } from 'vitest';

import { edgeHttp, type HttpInput, type HttpOutput, jsonHttpResponse } from '../../../src/data-plane/pipeline/edge-http.ts';
import { type AttemptResponse, type CandidateRequest, type CandidatesRequest, failover } from '../../../src/data-plane/pipeline/failover.ts';
import { createGatewayHttpHandler, type GatewayHttpFacts, startGatewayRun } from '../../../src/data-plane/pipeline/host.ts';
import { billableCall, observedTokenUsage, observeIdentity, scalarUsageFacts, usageResponseKeys } from '../../../src/data-plane/pipeline/observe-usage.ts';
import type { RouteCandidate } from '../../../src/data-plane/pipeline/services.ts';
import { priceUsage, type SettlementFacts, writeSettlement } from '../../../src/data-plane/pipeline/settlement.ts';
import { UpstreamTransportError } from '../../../src/dial/transport-error.ts';
import type { AuthVars } from '../../../src/middleware/auth.ts';
import type { ApiKey } from '../../../src/repo/types.ts';
import { initBackgroundSchedulerResolver } from '../../../src/runtime/background.ts';
import { Bytes, compose, defineEnding, type RunEvent, run, type StageEnv } from '@floway-dev/pipeline';

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

type Attempt = (candidate: RouteCandidate, env: StageEnv) => AttemptResponse;
const endpoint = (attempt: Attempt) => defineEnding<CandidateRequest, AttemptResponse>({
  name: 'upstream',
  request: { needs: ['route.candidate'] },
  return: { provides: ['response.http', ...usageResponseKeys] },
  execute: async (facts, _into, env) => attempt(facts['route.candidate'], env),
});

const counted = (model: RouteCandidate, env: StageEnv, status: number, output: number): AttemptResponse => ({
  ...scalarUsageFacts(env, billableCall(env, observeIdentity(model, model.upstreamModelId), status === 200 ? 'completed' : 'api-error',
    observedTokenUsage({ input: 5, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output }))),
  'response.http': jsonHttpResponse(status, { variant: model.upstreamModelId }, 10),
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
