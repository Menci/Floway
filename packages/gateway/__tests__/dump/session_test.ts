import { expect, test } from 'vitest';

import { installDumpStubs, MemoryLogStreamStore } from './test-fixtures.ts';
import { type HttpInput, type HttpOutput, jsonHttpResponse } from '../../src/data-plane/pipeline/edge-http.ts';
import { failedRender, renderedNow, type RenderFacts } from '../../src/data-plane/pipeline/render.ts';
import type { Settlement, SettlementFacts } from '../../src/data-plane/pipeline/settlement.ts';
import { initDumpBroker, initDumpStore } from '../../src/dump/registry.ts';
import { openDumpSession } from '../../src/dump/session.ts';
import { dumpLiveStreamId } from '../../src/dump/types.ts';
import type { ApiKey } from '../../src/repo/types.ts';
import { createDumpDecoder, projectWireExchanges } from '@floway-dev/dump';
import { Bytes, compose, defineEnding, run, secret } from '@floway-dev/pipeline';
import { initLogStreamStore } from '@floway-dev/platform';

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
  type Output = HttpOutput & SettlementFacts & RenderFacts;
  const pipeline = compose<HttpInput, Output, {}>('test.dump', {
    stages: [],
    ending: defineEnding<HttpInput, Output>({
      name: 'answer',
      request: { needs: ['request.http'] },
      return: { provides: ['response.http', 'response.render', 'response.settlement'] },
      execute: async (_facts, _into, env) => ({
        'response.http': jsonHttpResponse(201, { received: true }, env.clock()),
        ...renderedNow(env, render),
        'response.settlement': env.defer<Settlement>('settlement', Promise.resolve({
          persisted: true, errors: [], status: 201, outcome: render.kind === 'completed' ? 'success' : 'failed', identity: null, tokenUsage: { input: 7, output: 2 },
          firstOutputAt, streamEndedAt: null, upstreamStartedAt: 100, upstreamId: null, targetApi: null,
        })),
      }),
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
  const pipeline = compose<HttpInput, HttpOutput, {}>('test.dump-crash', {
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
