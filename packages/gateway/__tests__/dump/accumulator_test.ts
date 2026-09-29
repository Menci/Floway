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

test('DumpAccumulator leaves TTFT absent on a failure before any output', async () => {
  const stubs = installDumpStubs(initDumpStore, initDumpBroker);
  const tasks: Promise<unknown>[] = [];
  const scheduler = (p: Promise<unknown>) => { tasks.push(p); };

  const attempt = { upstreamCallStartedAt: 100, firstOutputTokenAt: null };
  const dump = new DumpAccumulator(
    buildApiKey(),
    makeSnapshot(),
    new Uint8Array([123, 125]),
    Date.now(),
    scheduler,
    true, // wantsStream: true
    attempt,
  );

  dump.failed('upstream 502 error before output');
  dump.finalize(502, []);
  await Promise.all(tasks);

  expect(stubs.stored).toHaveLength(1);
  expect(stubs.stored[0]!.record.meta.ttftMs).toBeNull();
});

test('DumpAccumulator leaves TTFT absent on a WebSocket prewarm response with no upstream call', async () => {
  const stubs = installDumpStubs(initDumpStore, initDumpBroker);
  const tasks: Promise<unknown>[] = [];
  const scheduler = (p: Promise<unknown>) => { tasks.push(p); };

  const attempt = { upstreamCallStartedAt: null, firstOutputTokenAt: null };
  const dump = new DumpAccumulator(
    buildApiKey(),
    makeSnapshot(),
    new Uint8Array([123, 125]),
    Date.now(),
    scheduler,
    true, // wantsStream: true
    attempt,
  );

  dump.finalize(200, []);
  await Promise.all(tasks);

  expect(stubs.stored).toHaveLength(1);
  expect(stubs.stored[0]!.record.meta.ttftMs).toBeNull();
});
