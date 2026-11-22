import { afterEach, expect, test, vi } from 'vitest';

import { MemoryLogStreamStore } from './test-fixtures.ts';
import { app } from '../../src/app.ts';
import { MODEL_CATALOG_REVISION } from '../../src/data-plane/providers/models-cache.ts';
import { initDumpBroker, initDumpStore } from '../../src/dump/registry.ts';
import type { DumpBrokerMessage } from '../../src/dump/types.ts';
import { FileDumpStore } from '../../src/repo/dump-store.ts';
import { initRepo } from '../../src/repo/index.ts';
import { modelsRefreshInputs } from '../../src/repo/models-refresh-inputs.ts';
import { SqlRepo } from '../../src/repo/sql.ts';
import { createSqliteTestDb } from '../repo/test-sqlite.ts';
import { saveUpstreamForTest } from '../repo/upstreams.ts';
import { buildCustomUpstreamRecord, flushAsyncWork } from '../test-utils/app.ts';
import { flushBackground } from '../test-utils/background-tracker.ts';
import { createDumpDecoder, projectWireView } from '@floway-dev/pipeline';
import { initFileStore, initLogStreamStore, MemoryFileStore, readLogStream } from '@floway-dev/platform';
import { stubProviderModel } from '@floway-dev/test-utils';

afterEach(() => vi.restoreAllMocks());

const encoder = new TextEncoder();

const readStream = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    text += decoder.decode(value, { stream: true });
  }
};

test('live dump streams pipeline NDJSON, commits a gzipped artifact, and publishes final attribution', async () => {
  const db = await createSqliteTestDb();
  const repo = new SqlRepo(db);
  initRepo(repo);
  const apiKey = {
    id: 'key_dump', userId: 1, name: 'Dump', key: 'raw-dump', serverSecret: '00'.repeat(32),
    createdAt: '2026-01-01T00:00:00.000Z', upstreamIds: null, randomizeUpstreams: false,
    deletedAt: null, dumpRetentionSeconds: 3600, openaiResponsesRetentionSeconds: 0,
  } as const;
  await repo.users.save({ id: 1, username: 'admin', passwordHash: null, isAdmin: true, createdAt: '1970-01-01T00:00:00.000Z', deletedAt: null });
  await repo.apiKeys.save(apiKey);
  await repo.accessRecords.save({ principal: { kind: 'user', id: 1 }, scope: { kind: 'upstreams' }, sortOrder: 0, values: { 'Model.Use': true } });
  const files = new MemoryFileStore();
  initFileStore(files);
  const store = new FileDumpStore(db, files);
  initDumpStore(store);
  const liveStore = new MemoryLogStreamStore();
  initLogStreamStore(liveStore);
  const published: DumpBrokerMessage[] = [];
  initDumpBroker({
    async publish(_channel, frame) { published.push(frame); },
    async closeChannel() {},
    subscribe() { return (async function*() {})(); },
  });

  const providerModel = stubProviderModel({
    id: 'chat-public',
    upstreamModelId: 'chat-upstream',
    kind: 'chat',
    endpoints: { openaiChatCompletions: {} },
  });
  const record = buildCustomUpstreamRecord({
    id: 'up_chat',
    name: 'Chat upstream',
    config: {
      baseUrl: 'https://chat.example.com',
      apiKey: 'sk-chat',
      endpoints: { openaiChatCompletions: {} },
      ingressHeadersRules: [],
      modelsFetch: { enabled: false, authStyle: 'bearer' },
      models: [providerModel],
    },
  });
  await repo.upstreams.deleteAll();
  await saveUpstreamForTest(repo.upstreams, record);
  const stored = await repo.upstreams.getById(record.id);
  if (stored === null) throw new Error('missing seeded upstream');
  await repo.upstreams.publishModelsRefresh({
    id: stored.id,
    configVersion: stored.configVersion,
    cacheEpoch: 0,
    refreshInputs: modelsRefreshInputs(stored),
    cache: { revision: MODEL_CATALOG_REVISION, fetchedAt: Date.now(), models: [providerModel] },
  });

  let upstreamController!: ReadableStreamDefaultController<Uint8Array>;
  const upstreamBody = new ReadableStream<Uint8Array>({
    start(controller) {
      upstreamController = controller;
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: 'chatcmpl_1', object: 'chat.completion.chunk', created: 1, model: 'chat-upstream', choices: [{ delta: { content: 'hello' }, index: 0 }] })}\n\n`));
    },
  });
  const response = new Response(upstreamBody, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).includes('/v1/models')
    ? Response.json({ object: 'list', data: [{ id: 'chat-upstream', supported_endpoints: ['/chat/completions'] }] })
    : response));

  const clientResponse = await app.request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
    body: JSON.stringify({ model: 'chat-public', messages: [{ role: 'user', content: 'hello' }], stream: true }),
  });
  expect(clientResponse.status).toBe(200);
  await vi.waitFor(() => expect(published.some(frame => frame.event === 'started')).toBe(true));
  const started = published.find((frame): frame is Extract<DumpBrokerMessage, { event: 'started' }> => frame.event === 'started');
  if (started === undefined) throw new Error('missing started frame');
  const recordId = started.data.id;
  const liveResponse = await app.request(`/api/dump/keys/${apiKey.id}/records/${recordId}/live?offset=0`, {
    headers: { 'x-api-key': apiKey.key },
  });
  expect(liveResponse.status).toBe(200);
  const liveIterator = readLogStream(liveResponse)[Symbol.asyncIterator]();
  const firstLive = await liveIterator.next();
  expect(firstLive.done).toBe(false);

  upstreamController.enqueue(encoder.encode(`data: ${JSON.stringify({ id: 'chatcmpl_1', object: 'chat.completion.chunk', created: 1, model: 'chat-upstream', choices: [{ delta: { content: ' world' }, index: 0, finish_reason: 'stop' }] })}\n\n`));
  upstreamController.enqueue(encoder.encode(`data: ${JSON.stringify({ id: 'chatcmpl_1', object: 'chat.completion.chunk', created: 1, model: 'chat-upstream', choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })}\n\n`));
  upstreamController.enqueue(encoder.encode('data: [DONE]\n\n'));
  upstreamController.close();
  expect(await clientResponse.text()).toContain('world');
  await flushAsyncWork();
  await flushBackground();

  const records = await store.list(apiKey.id, { limit: 10 });
  expect(records).toHaveLength(1);
  const meta = records[0]!;
  expect(meta).toMatchObject({
    status: 200,
    model: 'chat-public',
    upstream: { id: 'up_chat', name: 'Chat upstream' },
    inputTokens: 5,
    outputTokens: 2,
  });
  expect(meta.responseBytes).toBeGreaterThan(0);
  expect(meta.ttftMs).toEqual(expect.any(Number));
  const artifactResponse = await app.request(`/api/dump/keys/${apiKey.id}/records/${meta.id}/artifact`, {
    headers: { 'x-api-key': apiKey.key },
  });
  expect(artifactResponse.status).toBe(200);
  const artifactText = await artifactResponse.text();
  const decoder = createDumpDecoder();
  const modelView = decoder.pushNdjsonChunk(artifactText, { final: true });
  const wire = projectWireView(modelView);
  expect(wire.downstreamRequest).toMatchObject({ method: 'POST', url: { origin: 'http://localhost', pathname: '/v1/chat/completions' } });
  expect(wire.downstreamResponse).toMatchObject({ status: 200 });
  expect(wire.upstreamAttempts).toHaveLength(1);
  expect(published.some(frame => frame.event === 'started' && frame.data.id === meta.id)).toBe(true);
  const appended = published.find(frame => frame.event === 'appended' && frame.data.id === meta.id);
  expect(appended).toMatchObject({ event: 'appended', data: { status: 200, model: 'chat-public', inputTokens: 5, outputTokens: 2 } });

  const resumed: Uint8Array[] = [];
  if (firstLive.value !== undefined) resumed.push(firstLive.value);
  for (;;) {
    const next = await liveIterator.next();
    if (next.done) break;
    resumed.push(next.value);
  }
  expect(new TextDecoder().decode(resumed[0])).toContain('"k":"run"');
});

test('invalid JSON records a synthetic downstream request and response artifact', async () => {
  const db = await createSqliteTestDb();
  const repo = new SqlRepo(db);
  initRepo(repo);
  const apiKey = {
    id: 'key_dump_invalid', userId: 1, name: 'Dump', key: 'raw-dump-invalid', serverSecret: '00'.repeat(32),
    createdAt: '2026-01-01T00:00:00.000Z', upstreamIds: null, randomizeUpstreams: false,
    deletedAt: null, dumpRetentionSeconds: 3600, openaiResponsesRetentionSeconds: 0,
  } as const;
  await repo.users.save({ id: 1, username: 'admin', passwordHash: null, isAdmin: true, createdAt: '1970-01-01T00:00:00.000Z', deletedAt: null });
  await repo.apiKeys.save(apiKey);
  const files = new MemoryFileStore();
  initFileStore(files);
  const store = new FileDumpStore(db, files);
  initDumpStore(store);
  initDumpBroker({
    async publish() {},
    async closeChannel() {},
    subscribe() { return (async function*() {})(); },
  });
  const response = await app.request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
    body: '{',
  });
  expect(response.status).toBe(502);
  await flushAsyncWork();
  await flushBackground();
  const [meta] = await store.list(apiKey.id, { limit: 1 });
  expect(meta).toBeDefined();
  const artifact = await store.getArtifactStream(apiKey.id, meta!.id);
  if (artifact === null) throw new Error('missing artifact');
  const model = createDumpDecoder().pushNdjsonChunk(await readStream(artifact), { final: true });
  const wire = projectWireView(model);
  expect(wire.downstreamRequest).toMatchObject({ method: 'POST', url: { origin: 'http://localhost', pathname: '/v1/chat/completions' } });
  expect(wire.downstreamResponse).toMatchObject({ status: 502 });
});
