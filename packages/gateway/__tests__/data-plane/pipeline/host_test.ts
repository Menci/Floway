import { Hono } from 'hono';
import { expect, test, vi } from 'vitest';

import { gatewayFactSpace, httpEntry } from '../../../src/data-plane/pipeline/facts.ts';
import { servePipeline, startPipeline } from '../../../src/data-plane/pipeline/host.ts';
import { responseHead, writeHttpResponse } from '../../../src/data-plane/pipeline/response.ts';
import { createGatewayServices, type GatewayServices } from '../../../src/data-plane/pipeline/services.ts';
import type { AuthVars } from '../../../src/middleware/auth.ts';
import { initRepo } from '../../../src/repo/index.ts';
import { initBackgroundSchedulerResolver } from '../../../src/runtime/background.ts';
import { testAdminUser, setupAppTest } from '../../test-utils/app.ts';
import type { HttpStreamError } from '@floway-dev/http';
import { move, type Result } from '@floway-dev/pipeline';

const { compose, defineStage } = gatewayFactSpace<{}>();

test('HTTP runs share provider services across repository initialization', async () => {
  const { apiKey, repo } = await setupAppTest();
  const observations: GatewayServices[] = [];
  const { compose, defineStage } = gatewayFactSpace<GatewayServices>();
  const ending = defineStage({
    name: 'test.provider-service-scope',
    request: { needs: httpEntry },
    return: { provides: ['response.http'] },
    async execute(_facts, scope) {
      observations.push(scope.services);
      return { 'response.http': move(responseHead(204)) };
    },
  });
  const pipeline = compose('test.provider-service-scope', { entry: httpEntry, exit: ['response.http'], stages: [], ending });
  const app = new Hono<{ Variables: AuthVars }>();
  app.get('/', c => {
    c.set('apiKey', apiKey);
    c.set('user', testAdminUser);
    return servePipeline(c, pipeline, createGatewayServices);
  });

  expect((await app.request('/')).status).toBe(204);
  initRepo(repo);
  expect((await app.request('/')).status).toBe(204);
  const [first, second] = observations;
  expect(observations).toHaveLength(2);
  for (const kind of ['chatgpt', 'claudeCode', 'copilot', 'kimiCode', 'ollama'] as const) {
    expect(second![kind]).toBe(first![kind]);
  }
  expect(first!.fetcher).not.toBe(second!.fetcher);
});

test('the HTTP host aborts on client cancellation and waits through native done', async () => {
  const client = new AbortController();
  const aborted = Promise.withResolvers<unknown>();
  const allowNativeDone = Promise.withResolvers<void>();
  let drained = false;
  const ending = defineStage({
    name: 'test.streaming-response',
    request: { needs: [] },
    return: { provides: ['response.http'] },
    async execute(_facts, scope) {
      const body = scope.createStream(async function* ({ signal }): AsyncIterable<Result<Uint8Array, HttpStreamError>> {
        yield { ok: true, value: new TextEncoder().encode('first') };
        expect(signal.aborted).toBe(true);
        aborted.resolve(signal.reason);
        yield { ok: false, error: { kind: 'abort', cause: signal.reason } };
        await allowNativeDone.promise;
        drained = true;
      });
      return { 'response.http': move({ ...responseHead(200), body }) };
    },
  });
  const pipeline = compose('test.streaming-response', { entry: [], exit: ['response.http'], stages: [], ending });
  const finish = vi.fn();
  const handle = startPipeline(pipeline, {}, {}, client.signal, { event: () => {}, finish });
  const response = writeHttpResponse((await handle.result)['response.http']!, handle.root);

  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe('first');
  const cancel = reader.cancel('client closed');
  try {
    expect(await aborted.promise).toBe('client closed');
    expect(finish).not.toHaveBeenCalled();
  } finally {
    allowNativeDone.resolve();
  }
  await cancel;
  await handle.done;
  expect(drained).toBe(true);
  expect(finish).toHaveBeenCalledOnce();
});

test('a response body failure aborts the HTTP root before joining native done', async () => {
  const client = new AbortController();
  const failure = new Error('upstream response body failed');
  const allowNativeDone = Promise.withResolvers<void>();
  let drained = false;
  const ending = defineStage({
    name: 'test.failing-body',
    request: { needs: [] },
    return: { provides: ['response.http'] },
    async execute(_facts, scope) {
      const body = scope.createStream(async function* ({ signal }): AsyncIterable<Result<Uint8Array, HttpStreamError>> {
        yield { ok: true, value: new TextEncoder().encode('first') };
        yield { ok: false, error: { kind: 'transport', cause: failure } };
        expect(signal.reason).toBe(failure);
        await allowNativeDone.promise;
        drained = true;
      });
      return { 'response.http': move({ ...responseHead(200), body }) };
    },
  });
  const pipeline = compose('test.failing-body', { entry: [], exit: ['response.http'], stages: [], ending });
  const finish = vi.fn();
  const handle = startPipeline(pipeline, {}, {}, client.signal, { event: () => {}, finish });
  const response = writeHttpResponse((await handle.result)['response.http']!, handle.root);

  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe('first');
  try {
    await expect(reader.read()).rejects.toBe(failure);
    expect(handle.root.signal.reason).toBe(failure);
    expect(finish).not.toHaveBeenCalled();
  } finally {
    allowNativeDone.resolve();
  }
  await handle.done;
  expect(drained).toBe(true);
  expect(finish).toHaveBeenCalledOnce();
});

test('the HTTP host renders a pre-response pipeline panic with its stack and joins finalization', async () => {
  const { apiKey } = await setupAppTest();
  const background: Promise<unknown>[] = [];
  initBackgroundSchedulerResolver(() => promise => {
    // Keep the rejection observable without an unhandled rejection before the HTTP response.
    void promise.catch(() => undefined);
    background.push(promise);
  });
  const error = new Error('deliberate pipeline panic');
  const ending = defineStage({
    name: 'test.panicking-response',
    request: { needs: httpEntry },
    return: { provides: ['response.http'] },
    async execute() { throw error; },
  });
  const pipeline = compose('test.panicking-response', { entry: httpEntry, exit: ['response.http'], stages: [], ending });
  const app = new Hono<{ Variables: AuthVars }>();
  app.get('/', c => {
    c.set('apiKey', apiKey);
    c.set('user', testAdminUser);
    return servePipeline(c, pipeline, async input => input);
  });

  const response = await app.request('/');
  expect(response.status).toBe(500);
  expect(await response.json()).toMatchObject({ error: { message: error.message, stack: error.stack, path: '/' } });
  expect(background).toHaveLength(1);
  await expect(background[0]).rejects.toBe(error);
});
