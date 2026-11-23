import { expect, test, vi } from 'vitest';

import { installDumpStubs, MemoryLogStreamStore } from './test-fixtures.ts';
import type { CallRecordSummary } from '../../src/data-plane/pipeline/call-metering.ts';
import { type HttpInput, type HttpOutput, jsonHttpResponse } from '../../src/data-plane/pipeline/edge-http.ts';
import { failedRender, renderedNow, type RenderFacts } from '../../src/data-plane/pipeline/render.ts';
import { initDumpBroker, initDumpStore } from '../../src/dump/registry.ts';
import { openDumpSession } from '../../src/dump/session.ts';
import { dumpLiveStreamId } from '../../src/dump/types.ts';
import type { ApiKey } from '../../src/repo/types.ts';
import { createDumpDecoder, projectWireExchanges } from '@floway-dev/dump';
import { Bytes, compose, defineEnding, run, secret } from '@floway-dev/pipeline';
import { initLogStreamStore } from '@floway-dev/platform';

const findUpstream = vi.hoisted(() => vi.fn());
vi.mock('../../src/repo/index.ts', () => ({ getRepo: () => ({ upstreams: { getById: findUpstream } }) }));

const apiKey: ApiKey = {
  id: 'key_dump_session', userId: 1, name: 'test', key: 'secret', serverSecret: '00'.repeat(32),
  createdAt: '2026-01-01', upstreamIds: null, randomizeUpstreams: false, deletedAt: null,
  dumpRetentionSeconds: 3600, openaiResponsesRetentionSeconds: 0,
};

test.each([
  { firstOutputAt: null, render: { kind: 'completed' }, error: null },
  { firstOutputAt: 250, render: { kind: 'completed' }, error: null },
  { firstOutputAt: 250, render: failedRender('premature-eof', new Error('test response ended early')), error: { kind: 'failed', reason: 'test response ended early' } },
] as const)('dump session preserves raw/live HTTP and render metadata ($render.kind, first output $firstOutputAt)', async ({ firstOutputAt, render, error }) => {
  const stubs = installDumpStubs(initDumpStore, initDumpBroker);
  findUpstream.mockResolvedValue(null);
  const log = new MemoryLogStreamStore();
  initLogStreamStore(log);
  const raw = Bytes.fromUtf8('{\r\n  "model": "test" ,"input": [1, 2]\r\n}\n');
  const input: HttpInput = {
    'request.http': {
      method: 'POST', url: { origin: 'https://floway.test', pathname: '/v1/test' },
      headers: [['authorization', secret('test token')]], body: raw,
    },
  };
  const dump = openDumpSession(apiKey, input['request.http'], 'test')!;
  type Output = HttpOutput & RenderFacts;
  const entry = ['request.http'] as const;
  const exit = ['response.http', 'response.render'] as const;
  const pipeline = compose<HttpInput & Output, {}>()('test.dump', {
    entry,
    exit,
    stages: [],
    ending: defineEnding<HttpInput, Output>({
      name: 'answer',
      request: { needs: ['request.http'] },
      return: { provides: ['response.http', 'response.render'] },
      execute: async (_facts, scope) => {
        scope.defer<CallRecordSummary>('call.record', Promise.resolve({
          persisted: true, errors: [], status: 201, failed: render.kind !== 'completed', identity: null, tokenUsage: { input: 7, output: 2 },
          firstOutputAt, streamEndedAt: null, upstreamStartedAt: 100, upstreamId: 'upstream-test', targetApi: null,
        }));
        return { 'response.http': jsonHttpResponse(201, { received: true }, scope.clock()), ...renderedNow(scope, render) };
      },
    }),
  });
  const handle = run(pipeline, input, { services: {}, events: dump.sink, runId: dump.recordId, finalizationTimeoutMs: 100 });
  expect((await handle.result)['response.http'].status).toBe(201);
  expect(await handle.done).toEqual({ ok: true });
  await dump.completed;

  expect(stubs.published.map(item => item.frame.event)).toEqual(['started', 'appended']);
  expect(stubs.stored).toHaveLength(1);
  const record = stubs.stored[0]!;
  expect(record.meta).toMatchObject({ model: 'test', path: '/v1/test', status: 201, requestBytes: raw.byteLength, inputTokens: 7, outputTokens: 2, ttftMs: firstOutputAt === null ? null : 150, error });
  const decoder = createDumpDecoder();
  decoder.push(record.artifact);
  const trace = decoder.finish();
  const wire = projectWireExchanges(trace);
  expect(wire.downstreamRequest?.body).toBeInstanceOf(Bytes);
  expect((wire.downstreamRequest?.body as Bytes).utf8()).toBe(raw.utf8());
  expect(new TextDecoder().decode(record.artifact)).not.toContain('test token');

  const live = (await log.get(dumpLiveStreamId(apiKey.id, dump.recordId)))!;
  const liveChunks: Bytes[] = [];
  for await (const chunk of live.read(0, AbortSignal.timeout(1000))) liveChunks.push(Bytes.copy(chunk));
  expect(Bytes.concat(liveChunks).toUint8Array()).toEqual(record.artifact);
});

test('a failed run commits its host response status and the original crash trace', async () => {
  const stubs = installDumpStubs(initDumpStore, initDumpBroker);
  initLogStreamStore(new MemoryLogStreamStore());
  const facts: HttpInput = {
    'request.http': { method: 'POST', url: { origin: 'https://floway.test', pathname: '/v1/test' }, headers: [], body: Bytes.fromUtf8('{}') },
  };
  const dump = openDumpSession(apiKey, facts['request.http'])!;
  const failure = new Error('test gateway failure');
  const entry = ['request.http'] as const;
  const exit = ['response.http'] as const;
  const pipeline = compose<HttpInput & HttpOutput, {}>()('test.dump-crash', {
    entry,
    exit,
    stages: [],
    ending: defineEnding<HttpInput, HttpOutput>({
      name: 'crash', request: { needs: ['request.http'] }, return: { provides: ['response.http'] },
      execute: async () => { throw failure; },
    }),
  });
  const handle = run(pipeline, facts, { services: {}, events: dump.sink, runId: dump.recordId, finalizationTimeoutMs: 100 });
  await expect(handle.result).rejects.toBe(failure);
  dump.hostFailure(failure, 502, false);
  expect(await handle.done).toMatchObject({ ok: false });
  await dump.completed;

  expect(stubs.stored[0]?.meta).toMatchObject({ status: 502, requestBytes: 2, error: { kind: 'failed', reason: failure.message } });
  const decoder = createDumpDecoder();
  decoder.push(stubs.stored[0]!.artifact);
  const trace = decoder.finish();
  expect(trace.stages.get(trace.rootStageIds[0]!)?.error).toMatchObject({ message: failure.message, stack: failure.stack });
});

test('a truncated 13 MiB request keeps the live 429 status and upstream attribution', async () => {
  const stubs = installDumpStubs(initDumpStore, initDumpBroker);
  initLogStreamStore(new MemoryLogStreamStore());
  const upstream = { id: 'upstream-429', name: 'Upstream', kind: 'custom', hue: 22 };
  findUpstream.mockResolvedValue(upstream);
  const request = Bytes.adopt(new Uint8Array(13 * 1024 * 1024));
  const input: HttpInput = {
    'request.http': { method: 'POST', url: { origin: 'https://floway.test', pathname: '/v1/test' }, headers: [], body: request },
  };
  const dump = openDumpSession(apiKey, input['request.http'])!;
  const http = jsonHttpResponse(429, { error: 'rate limited' }, 0);
  const entry = ['request.http'] as const;
  const exit = ['response.http'] as const;
  const pipeline = compose<HttpInput & HttpOutput, {}>()('test.dump-truncated', {
    entry,
    exit,
    stages: [],
    ending: defineEnding<HttpInput, HttpOutput>({
      name: 'upstream-answer',
      request: { needs: ['request.http'] },
      return: { provides: ['response.http'] },
      execute: async (_facts, scope) => {
        scope.defer<CallRecordSummary>('call.record', Promise.resolve({
          persisted: true, errors: [], status: 429, failed: true, identity: null, tokenUsage: null,
          firstOutputAt: null, streamEndedAt: null, upstreamStartedAt: 0, upstreamId: upstream.id, targetApi: null,
        }));
        return { 'response.http': { ...http, exchange: 'upstream' } };
      },
    }),
  });
  const handle = run(pipeline, input, { services: {}, events: dump.sink, runId: dump.recordId, finalizationTimeoutMs: 100 });
  expect((await handle.result)['response.http'].status).toBe(429);
  expect(await handle.done).toEqual({ ok: true });
  await dump.completed;
  expect(stubs.stored).toHaveLength(1);
  expect(stubs.stored[0]!.meta).toMatchObject({
    status: 429, upstream, requestBytes: request.byteLength, responseBytes: Bytes.fromUtf8('{"error":"rate limited"}').byteLength,
    truncated: true, droppedEvents: expect.any(Number), error: { kind: 'upstream' },
  });
  const decoder = createDumpDecoder();
  decoder.push(stubs.stored[0]!.artifact);
  expect(decoder.finish().rootStageIds).toEqual([]);
});

test.each([
  { exchange: 'upstream' as const, status: 429, expected: { kind: 'upstream' } },
  { exchange: undefined, status: 400, expected: { kind: 'gateway' } },
])('unmetered non-2xx classifies by response.http.exchange ($exchange)', async ({ exchange, status, expected }) => {
  const stubs = installDumpStubs(initDumpStore, initDumpBroker);
  initLogStreamStore(new MemoryLogStreamStore());
  const input: HttpInput = {
    'request.http': { method: 'POST', url: { origin: 'https://floway.test', pathname: '/v1/messages/count_tokens' }, headers: [], body: Bytes.fromUtf8('{}') },
  };
  const dump = openDumpSession(apiKey, input['request.http'])!;
  const pipeline = compose<HttpInput & HttpOutput, {}>()('test.dump-unmetered-error', {
    entry: ['request.http'] as const,
    exit: ['response.http'] as const,
    stages: [],
    ending: defineEnding<HttpInput, HttpOutput>({
      name: 'answer',
      request: { needs: ['request.http'] },
      return: { provides: ['response.http'] },
      execute: async () => ({ 'response.http': { ...jsonHttpResponse(status, { error: 'err' }, 0), ...(exchange === undefined ? {} : { exchange }) } }),
    }),
  });
  const handle = run(pipeline, input, { services: {}, events: dump.sink, runId: dump.recordId, finalizationTimeoutMs: 100 });
  expect((await handle.result)['response.http'].status).toBe(status);
  expect(await handle.done).toEqual({ ok: true });
  await dump.completed;
  expect(stubs.stored[0]?.meta.error).toEqual(expected);
});
