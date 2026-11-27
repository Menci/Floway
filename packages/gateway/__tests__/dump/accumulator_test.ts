import { expect, test } from 'vitest';

import { installDumpStubs } from './test-fixtures.ts';
import { DumpAccumulator } from '../../src/dump/accumulator.ts';
import { initDumpBroker, initDumpStore } from '../../src/dump/registry.ts';
import type { ApiKey } from '../../src/repo/types.ts';

const buildApiKey = (overrides: Partial<ApiKey> = {}): ApiKey => ({
  id: 'key_dump_acc_test',
  userId: 1,
  name: 'test',
  key: 'sk-test',
  serverSecret: '00'.repeat(32),
  createdAt: '2026-01-01T00:00:00.000Z',
  upstreamIds: null,
  randomizeUpstreams: false,
  deletedAt: null,
  dumpRetentionSeconds: 3600,
  openaiResponsesRetentionSeconds: 0,
  ...overrides,
});

const makeSnapshot = () => ({
  method: 'POST',
  path: '/v1/chat/completions',
  headers: [['content-type', 'application/json']] as Array<[string, string]>,
  bodyByteLength: 2,
  streamError: null,
});

test('DumpAccumulator stamps TTFT on a streamed record when first token arrived', async () => {
  const stubs = installDumpStubs(initDumpStore, initDumpBroker);
  const tasks: Promise<unknown>[] = [];
  const scheduler = (p: Promise<unknown>) => { tasks.push(p); };

  const attempt = { upstreamCallStartedAt: 100, firstOutputTokenAt: 250 };
  const dump = new DumpAccumulator(
    buildApiKey(),
    makeSnapshot(),
    new Uint8Array([123, 125]),
    Date.now(),
    scheduler,
    true, // wantsStream
    attempt,
  );

  dump.finalize(200, []);
  await Promise.all(tasks);

  expect(stubs.stored).toHaveLength(1);
  expect(stubs.stored[0]!.record.meta.ttftMs).toBe(150);
});

test('DumpAccumulator leaves TTFT absent on a non-streaming record', async () => {
  const stubs = installDumpStubs(initDumpStore, initDumpBroker);
  const tasks: Promise<unknown>[] = [];
  const scheduler = (p: Promise<unknown>) => { tasks.push(p); };

  const attempt = { upstreamCallStartedAt: 100, firstOutputTokenAt: 250 };
  const dump = new DumpAccumulator(
    buildApiKey(),
    makeSnapshot(),
    new Uint8Array([123, 125]),
    Date.now(),
    scheduler,
    false, // wantsStream: false
    attempt,
  );

  dump.finalize(200, []);
  await Promise.all(tasks);

  expect(stubs.stored).toHaveLength(1);
  expect(stubs.stored[0]!.record.meta.ttftMs).toBeNull();
});

test.each(['put', 'publish'] as const)('reports an archive %s failure through the scheduler after delivering the response', async method => {
  const stubs = installDumpStubs(initDumpStore, initDumpBroker);
  const failure = new Error('archive failed', { cause: new Error('underlying storage failure') });
  stubs.failOn(method, failure);
  const tasks: Promise<unknown>[] = [];
  const dump = new DumpAccumulator(buildApiKey(), makeSnapshot(), new Uint8Array([123, 125]), Date.now(), work => { tasks.push(work); });

  const response = dump.finalize(new Response('delivered', { status: 201 }));
  expect(response.status).toBe(201);
  expect(tasks).toHaveLength(1);
  await Promise.all([
    expect(response.text()).resolves.toBe('delivered'),
    expect(tasks[0]).rejects.toBe(failure),
  ]);
  expect(stubs.stored).toHaveLength(method === 'publish' ? 1 : 0);
  expect(stubs.published).toHaveLength(0);
});

test('delivers the body before selected metadata is ready for storage', async () => {
  const stubs = installDumpStubs(initDumpStore, initDumpBroker);
  const tasks: Promise<unknown>[] = [];
  const selected = Promise.withResolvers<void>();
  const dump = new DumpAccumulator(buildApiKey(), makeSnapshot(), new Uint8Array(), Date.now(), work => { tasks.push(work); });
  const metadata = selected.promise.then(() => { dump.requestedModel('selected-model'); });
  const response = dump.finalize(new Response('client response'), metadata);

  await expect(response.text()).resolves.toBe('client response');
  expect(stubs.stored).toHaveLength(0);
  selected.resolve();
  await Promise.all(tasks);
  expect(stubs.stored[0]?.record.meta.model).toBe('selected-model');
});

test('cancels the actual HTTP body and records only delivered bytes', async () => {
  const stubs = installDumpStubs(initDumpStore, initDumpBroker);
  const tasks: Promise<unknown>[] = [];
  const reason = new Error('client disconnected');
  let cancelled: unknown;
  let pulls = 0;
  const dump = new DumpAccumulator(buildApiKey(), makeSnapshot(), new Uint8Array(), Date.now(), work => { tasks.push(work); });
  const response = dump.finalize(new Response(new ReadableStream<Uint8Array>({
    pull(output) {
      pulls++;
      output.enqueue(new TextEncoder().encode('partial'));
    },
    cancel(error) { cancelled = error; },
  }, { highWaterMark: 0 })));
  const reader = response.body!.getReader();

  await reader.read();
  await reader.cancel(reason);
  await Promise.all(tasks);
  expect(cancelled).toBe(reason);
  expect(pulls).toBe(1);
  expect(stubs.stored[0]?.record.capture?.response).toMatchObject({ complete: false, error: 'client disconnected' });
  expect(stubs.stored[0]?.record.meta.responseBytes).toBe(7);
});
