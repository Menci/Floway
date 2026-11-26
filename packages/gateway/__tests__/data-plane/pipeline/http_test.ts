import { Hono } from 'hono';
import { expect, test, vi } from 'vitest';

import { meteredStream, testCandidate } from './fixtures.ts';
import { computeUsage } from '../../../src/data-plane/pipeline/compute-usage.ts';
import { encode, encodedResponse, encodeStream } from '../../../src/data-plane/pipeline/encode.ts';
import { compose, defineStage } from '../../../src/data-plane/pipeline/facts.ts';
import { httpRequestFact, serveHttp } from '../../../src/data-plane/pipeline/http.ts';
import { measurePerformance } from '../../../src/data-plane/pipeline/performance.ts';
import { storeUsage } from '../../../src/data-plane/pipeline/store-usage.ts';
import { tokenUsageMeasurement } from '../../../src/data-plane/shared/telemetry/usage.ts';
import { initDumpBroker, initDumpStore } from '../../../src/dump/registry.ts';
import type { AuthVars } from '../../../src/middleware/auth.ts';
import { FileDumpStore } from '../../../src/repo/dump-store.ts';
import { initRepo } from '../../../src/repo/index.ts';
import { SqlRepo } from '../../../src/repo/sql.ts';
import type { ApiKey } from '../../../src/repo/types.ts';
import { initBackgroundSchedulerResolver } from '../../../src/runtime/background.ts';
import { generateServerSecret } from '../../../src/shared/server-secret.ts';
import { installDumpStubs } from '../../dump/test-fixtures.ts';
import { InMemoryRepo } from '../../repo/memory.ts';
import { createSqliteTestDb } from '../../repo/test-sqlite.ts';
import type { HttpBodyError } from '@floway-dev/http';
import { MemoryFileStore } from '@floway-dev/platform';

const createdAt = new Date().toISOString();
const apiKey: ApiKey = {
  id: 'key',
  userId: 1,
  name: 'test',
  key: 'synthetic-key',
  serverSecret: generateServerSecret(),
  createdAt,
  upstreamIds: null,
  randomizeUpstreams: false,
  deletedAt: null,
  dumpRetentionSeconds: null,
  openaiResponsesRetentionSeconds: 0,
};

const mount = (pipeline: Parameters<typeof serveHttp>[0], key: ApiKey = apiKey) =>
  new Hono<{ Variables: AuthVars }>().use('*', async (c, next) => {
    c.set('apiKey', key);
    c.set('user', { id: 1, username: 'test', passwordHash: null, isAdmin: false, createdAt, deletedAt: null });
    await next();
  }).get('/stream', serveHttp(pipeline));

test('HTTP request facts remove key query fields without re-encoding neighboring data', async () => {
  const request = new Request('https://floway.example.test/v1/embeddings?q=a%20b&%6bey=secret&q=~&key=other');
  expect((await httpRequestFact(request)).url).toBe('https://floway.example.test/v1/embeddings?q=a%20b&q=~');
});

test('HTTP host aborts an open body when another root dependency panics', async () => {
  initRepo(new InMemoryRepo());
  const background: Promise<unknown>[] = [];
  initBackgroundSchedulerResolver(() => job => { background.push(job); });
  const panic = Promise.withResolvers<never>();
  const bodyStarted = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<unknown>();
  const ending = defineStage({
    name: 'stream-and-deferred-fixture',
    request: { needs: [] },
    return: { provides: ['response.http', 'response.usage'] },
    async execute(_facts, scope) {
      const body = scope.createStream<Uint8Array, HttpBodyError>(async function* (producer) {
        await new Promise<void>(resolve => {
          producer.signal.addEventListener('abort', () => resolve(), { once: true });
          bodyStarted.resolve();
        });
        aborted.resolve(producer.signal.reason);
        yield { ok: false, error: { kind: 'abort', cause: producer.signal.reason } };
      });
      return {
        'response.http': { status: 200, statusText: '', headers: [], body },
        'response.usage': scope.createDeferred(() => panic.promise),
      };
    },
  });
  const pipeline = compose('http-root-fixture', {
    entry: [],
    exit: ['response.http', 'response.usage'],
    stages: [],
    ending,
  });
  const app = mount(pipeline);
  const response = await app.request('/stream');
  expect(response.status).toBe(200);
  await bodyStarted.promise;
  const defect = new Error('test deferred panic');
  panic.reject(defect);
  await expect(response.arrayBuffer()).rejects.toBe(defect);
  await expect(aborted.promise).resolves.toBe(defect);
  await Promise.all(background);
});

test('HTTP host aborts on a byte error before the producer finishes draining', async () => {
  initRepo(new InMemoryRepo());
  const cause = new Error('broken HTTP body');
  const cleanup = Promise.withResolvers<unknown>();
  const finish = Promise.withResolvers<void>();
  const drained = Promise.withResolvers<void>();
  const ending = defineStage({
    name: 'byte-error-fixture',
    request: { needs: [] },
    return: { provides: ['response.http'] },
    async execute(_facts, scope) {
      const body = scope.createStream<Uint8Array, HttpBodyError>(async function* (producer) {
        const aborted = new Promise<unknown>(resolve => {
          producer.signal.addEventListener('abort', () => resolve(producer.signal.reason), { once: true });
        });
        yield { ok: false, error: { kind: 'transport', cause } };
        cleanup.resolve(await aborted);
        await finish.promise;
        drained.resolve();
      });
      return { 'response.http': { status: 200, statusText: '', headers: [], body } };
    },
  });
  const pipeline = compose('http-byte-error-fixture', {
    entry: [],
    exit: ['response.http'],
    stages: [],
    ending,
  });
  const response = await mount(pipeline).request('/stream');
  expect(response.status).toBe(200);
  try {
    await expect(response.arrayBuffer()).rejects.toBe(cause);
    await expect(cleanup.promise).resolves.toBe(cause);
  } finally {
    finish.resolve();
  }
  await drained.promise;
}, 2_000);

test('archives an encoded upstream stream error even when its billable prefix already settled usage', async () => {
  const db = await createSqliteTestDb();
  const repo = new SqlRepo(db);
  const key = { ...apiKey, dumpRetentionSeconds: 3600 };
  await repo.apiKeys.save(key);
  initRepo(repo);
  const background: Promise<unknown>[] = [];
  initBackgroundSchedulerResolver(() => job => { background.push(job); });
  const dumps = installDumpStubs(initDumpStore, initDumpBroker);
  const store = new FileDumpStore(db, new MemoryFileStore());
  initDumpStore(store);

  const release = Promise.withResolvers<void>();
  const text = new TextEncoder();
  const pipeline = compose('http-stream-archive-fixture', {
    entry: ['request.auth.apiKeyId', 'serve.runtimeLocation'],
    exit: ['response.http', 'response.outcome', 'response.performance', 'response.usage'],
    stages: [
      encode('openaiCompletions', ({ http, outcome }, scope) => {
        if (http === null || outcome.kind !== 'stream') throw new Error('Expected the fixture stream');
        const body = encodeStream(outcome.stream, scope, item =>
          [text.encode(item.ok ? 'data: output\n\n' : 'data: upstream error\n\n')],
        () => [text.encode('data: [DONE]\n\n')]);
        return encodedResponse(http, body, 'text/event-stream');
      }),
      testCandidate,
      measurePerformance('openaiCompletions', 'chat', frame => frame.choices.some(choice => Boolean(choice.text))),
      storeUsage,
      computeUsage('openaiCompletions', {
        stream: () => ({ frame: () => [tokenUsageMeasurement({ output: 3 })], done: () => [] }),
      }),
    ],
    ending: meteredStream({ failure: { kind: 'protocol', cause: new Error('upstream emitted a terminal error') }, release: release.promise }),
  });
  const response = await mount(pipeline, key).request('/stream');
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  expect(await reader.read()).toMatchObject({ value: text.encode('data: output\n\n'), done: false });
  try {
    await vi.waitFor(async () => expect(await repo.usage.listAll()).toMatchObject([{ requests: 1 }]));
    expect(dumps.published).toHaveLength(0);
  } finally {
    release.resolve();
  }
  expect(await reader.read()).toMatchObject({ value: text.encode('data: upstream error\n\n'), done: false });
  expect((await reader.read()).done).toBe(true);
  await Promise.all(background);
  expect(await store.list(key.id, { failures: true, limit: 10 })).toMatchObject([
    { status: 200, outputTokens: 3, error: { kind: 'upstream' } },
  ]);
  expect(dumps.published).toHaveLength(1);
});
