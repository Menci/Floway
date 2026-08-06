import { test } from 'vitest';

import { installDumpStubs } from './test-fixtures.ts';
import { DumpAccumulator } from '../../src/dump/accumulator.ts';
import { initDumpBroker, initDumpStore } from '../../src/dump/registry.ts';
import type { StoredDumpRecord } from '../../src/dump/types.ts';
import type { ApiKey } from '../../src/repo/types.ts';
import { assertEquals, assertStringIncludes } from '@floway-dev/test-utils';

type CaptureLimits = NonNullable<ConstructorParameters<typeof DumpAccumulator>[5]>;

const apiKey: ApiKey = {
  id: 'dump-key',
  userId: 1,
  name: 'Dump key',
  key: 'raw-key',
  serverSecret: '11'.repeat(32),
  createdAt: '2026-01-01T00:00:00.000Z',
  upstreamIds: null,
  deletedAt: null,
  dumpRetentionSeconds: 3600,
  responsesRetentionSeconds: 0,
};

const createHarness = (captureLimits?: CaptureLimits, requestBody = new Uint8Array()) => {
  const dumps = installDumpStubs(initDumpStore, initDumpBroker);
  const backgroundTasks: Promise<unknown>[] = [];
  const args = [
    apiKey,
    {
      method: 'POST',
      path: '/v1/test',
      headers: [] as Array<[string, string]>,
      bodyByteLength: requestBody.byteLength,
      streamError: null,
    },
    requestBody,
    Date.now(),
    (task: Promise<unknown>) => { backgroundTasks.push(task); },
  ] as const;
  const accumulator = captureLimits === undefined
    ? new DumpAccumulator(...args)
    : new DumpAccumulator(...args, captureLimits);
  return {
    accumulator,
    dumps,
    settle: async () => await Promise.all(backgroundTasks),
  };
};

const onlyRecord = (records: ReadonlyArray<{ keyId: string; record: StoredDumpRecord }>): StoredDumpRecord => {
  assertEquals(records.length, 1);
  return records[0]!.record;
};

test('downstream cancellation immediately reaches an idle response source and settles its dump', async () => {
  const { accumulator, dumps, settle } = createHarness();
  const firstChunk = Uint8Array.of(1, 2, 3);
  const firstChunkBytes = firstChunk.byteLength;
  const cancelReason = Object.create(null) as object;
  let sourceController!: ReadableStreamDefaultController<Uint8Array>;
  let sourceCancelReason: unknown;
  let resolveSourceCancel: (() => void) | undefined;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      sourceController = controller;
      controller.enqueue(firstChunk);
    },
    cancel(reason) {
      sourceCancelReason = reason;
      return new Promise<void>(resolve => { resolveSourceCancel = resolve; });
    },
  });
  const response = accumulator.finalize(new Response(source, {
    headers: { 'content-type': 'text/event-stream' },
  }));
  const reader = response.body!.getReader();

  const firstRead = await reader.read();
  assertEquals(firstRead.done, false);
  assertEquals(Array.from(firstRead.value!), [1, 2, 3]);
  const cancellation = reader.cancel(cancelReason);
  const propagatedBeforeSourceSettled = sourceCancelReason === cancelReason;
  accumulator.frame({ type: 'event', event: { type: 'late-after-cancel' } });

  if (propagatedBeforeSourceSettled) {
    await settle();
    resolveSourceCancel!();
  } else {
    // This cleanup makes the former tee implementation finish rather than
    // leaving the regression test itself with a permanently pending task.
    sourceController.close();
  }
  await cancellation;
  await settle();

  assertEquals(propagatedBeforeSourceSettled, true);
  assertEquals(sourceCancelReason, cancelReason);
  const record = onlyRecord(dumps.stored);
  assertEquals(record.meta.responseBytes, firstChunkBytes);
  assertEquals(record.meta.error?.kind, 'failed');
  if (record.meta.error?.kind === 'failed') {
    assertStringIncludes(record.meta.error.reason, 'Downstream response body canceled: [object Object]');
  }
  if (record.response.body.type !== 'stream') throw new Error('expected stream dump body');
  assertEquals(record.response.body.events, []);
});

test('response capture applies downstream backpressure and counts chunks as they are delivered', async () => {
  const { accumulator, dumps, settle } = createHarness();
  const chunks = [new Uint8Array(), Uint8Array.of(1, 2), Uint8Array.of(3, 4)];
  let pulls = 0;
  const source = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[pulls++];
      if (chunk === undefined) controller.close();
      else controller.enqueue(chunk);
    },
  }, { highWaterMark: 0 });
  const response = accumulator.finalize(new Response(source));

  for (let i = 0; i < 5; i++) await Promise.resolve();
  const pullsBeforeClientRead = pulls;
  const delivered = new Uint8Array(await response.arrayBuffer());
  await settle();

  assertEquals(pullsBeforeClientRead, 0);
  assertEquals(Array.from(delivered), [1, 2, 3, 4]);
  const record = onlyRecord(dumps.stored);
  assertEquals(record.meta.responseBytes, 4);
  assertEquals(record.meta.error, null);
});

test('non-frame response capture stores a bounded prefix and reports the full delivered byte count', async () => {
  const { accumulator, dumps, settle } = createHarness({
    requestBodyBytes: 4,
    responseBodyBytes: 4,
    streamEventBytes: 1024,
    streamEvents: 10,
  });
  const backing = Uint8Array.of(99, 1, 2, 3, 4, 5, 6, 99);
  const payload = backing.subarray(1, 7);
  accumulator.failed('x'.repeat(500));
  const response = accumulator.finalize(new Response(payload));

  assertEquals(Array.from(new Uint8Array(await response.arrayBuffer())), [1, 2, 3, 4, 5, 6]);
  await settle();

  const record = onlyRecord(dumps.stored);
  assertEquals(record.meta.responseBytes, 6);
  assertEquals(record.meta.error?.kind, 'failed');
  if (record.meta.error?.kind === 'failed') {
    assertStringIncludes(record.meta.error.reason, '4-byte limit');
    assertStringIncludes(record.meta.error.reason, 'stored body is truncated');
  }
  if (record.response.body.type !== 'bytes') throw new Error('expected bytes dump body');
  assertEquals(Array.from(record.response.body.body), [1, 2, 3, 4]);
});

test('canonical frames suppress duplicate wire-body retention', async () => {
  const { accumulator, dumps, settle } = createHarness({
    requestBodyBytes: 4,
    responseBodyBytes: 0,
    streamEventBytes: 1024,
    streamEvents: 10,
  });
  accumulator.frame({ type: 'event', event: { type: 'captured' } });
  const response = accumulator.finalize(new Response(Uint8Array.of(1, 2, 3)));

  assertEquals(Array.from(new Uint8Array(await response.arrayBuffer())), [1, 2, 3]);
  await settle();

  const record = onlyRecord(dumps.stored);
  assertEquals(record.meta.responseBytes, 3);
  assertEquals(record.meta.error, null);
  if (record.response.body.type !== 'stream') throw new Error('expected stream dump body');
  assertEquals(record.response.body.events.length, 1);
});

test('stream event capture stops at its event-count ceiling and surfaces truncation', async () => {
  const { accumulator, dumps, settle } = createHarness({
    requestBodyBytes: 4,
    responseBodyBytes: 4,
    streamEventBytes: 1024,
    streamEvents: 1,
  });
  accumulator.frame({ type: 'event', event: { type: 'first' } });
  accumulator.frame({ type: 'event', event: { type: 'second' } });
  accumulator.recordSentPayloadBytes(12);
  accumulator.finalize(200, [['content-type', 'text/event-stream']]);
  await settle();

  const record = onlyRecord(dumps.stored);
  assertEquals(record.meta.responseBytes, 12);
  assertEquals(record.meta.error?.kind, 'failed');
  if (record.meta.error?.kind === 'failed') {
    assertStringIncludes(record.meta.error.reason, 'truncated after 1 events');
  }
  if (record.response.body.type !== 'stream') throw new Error('expected stream dump body');
  assertEquals(record.response.body.events.map(event => event.frame), [
    { type: 'event', event: { type: 'first' } },
  ]);
});

test('stream event capture rejects an individually oversized canonical frame', async () => {
  const { accumulator, dumps, settle } = createHarness({
    requestBodyBytes: 4,
    responseBodyBytes: 4,
    streamEventBytes: 2,
    streamEvents: 10,
  });
  accumulator.frame({ type: 'event', event: { type: 'oversized' } });
  accumulator.finalize(200, [['content-type', 'text/event-stream']]);
  await settle();

  const record = onlyRecord(dumps.stored);
  assertEquals(record.meta.error?.kind, 'failed');
  if (record.meta.error?.kind === 'failed') {
    assertStringIncludes(record.meta.error.reason, '10 events, 2 bytes');
  }
  if (record.response.body.type !== 'stream') throw new Error('expected stream dump body');
  assertEquals(record.response.body.events, []);
});

test('hostile canonical frame serialization failures stay inside dump capture', async () => {
  const { accumulator, dumps, settle } = createHarness();
  const hostile: Record<string, unknown> = {};
  Object.defineProperty(hostile, 'value', {
    enumerable: true,
    get() { throw Object.create(null); },
  });

  accumulator.frame({ type: 'event', event: hostile });
  accumulator.finalize(200, [['content-type', 'text/event-stream']]);
  await settle();

  const record = onlyRecord(dumps.stored);
  assertEquals(record.meta.error?.kind, 'failed');
  if (record.meta.error?.kind === 'failed') {
    assertStringIncludes(record.meta.error.reason, 'Dump stream event capture failed');
  }
  if (record.response.body.type !== 'stream') throw new Error('expected stream dump body');
  assertEquals(record.response.body.events, []);
});

test('request capture stores a bounded prefix while metadata retains the delivered byte count', async () => {
  const { accumulator, dumps, settle } = createHarness({
    requestBodyBytes: 4,
    responseBodyBytes: 0,
    streamEventBytes: 1024,
    streamEvents: 10,
  }, Uint8Array.of(1, 2, 3, 4, 5, 6));

  accumulator.finalize(200, []);
  await settle();

  const record = onlyRecord(dumps.stored);
  assertEquals(record.meta.requestBytes, 6);
  assertEquals(Array.from(record.request.body), [1, 2, 3, 4]);
  assertEquals(record.meta.error?.kind, 'failed');
  if (record.meta.error?.kind === 'failed') {
    assertStringIncludes(record.meta.error.reason, '4-byte limit');
    assertStringIncludes(record.meta.error.reason, 'stored body is truncated');
  }
});
