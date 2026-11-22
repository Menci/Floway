import { expect, test } from 'vitest';

import { installDumpStubs, MemoryLogStreamStore } from './test-fixtures.ts';
import { type HttpInput, type HttpOutput, jsonHttpResponse } from '../../src/data-plane/pipeline/edge-http.ts';
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

test.each([null, 250])('dump session publishes live bytes and commits raw HTTP artifacts (first output %s)', async firstOutputAt => {
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
  const pipeline = compose<HttpInput, HttpOutput & SettlementFacts, {}>('test.dump', {
    stages: [],
    ending: defineEnding<HttpInput, HttpOutput & SettlementFacts>({
      name: 'answer',
      request: { needs: ['request.http'] },
      return: { provides: ['response.http', 'response.settlement'] },
      execute: async (_facts, _into, env) => ({
        'response.http': jsonHttpResponse(201, { received: true }, env.clock()),
        'response.settlement': env.defer<Settlement>('settlement', Promise.resolve({
          persisted: true, errors: [], status: 201, outcome: 'success', identity: null, tokenUsage: { input: 7, output: 2 },
          firstOutputAt, streamEndedAt: null, upstreamStartedAt: 100, upstreamId: null, targetApi: null, requestedModel: 'test',
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
  expect(record.meta).toMatchObject({ model: 'test', path: '/v1/test', status: 201, requestBytes: raw.byteLength, inputTokens: 7, outputTokens: 2, ttftMs: firstOutputAt === null ? null : 150 });
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
