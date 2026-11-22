import { test } from 'vitest';

import { initDumpBroker, initDumpStore } from '../../src/dump/registry.ts';
import type { DumpStore } from '../../src/dump/store-contract.ts';
import type { DumpMetadata } from '../../src/dump/types.ts';
import { dumpLiveStreamId } from '../../src/dump/types.ts';
import { fakeMeta as baseFakeMeta, installDumpStubs } from '../dump/test-fixtures.ts';
import { requestApp, setupAppTest } from '../test-utils/app.ts';
import { initLogStreamStore, readLogStream } from '@floway-dev/platform';
import type { LogStream, LogStreamStore } from '@floway-dev/platform';
import { assertEquals, assertExists } from '@floway-dev/test-utils';

const fakeMeta = (id: string, completedAt: number): DumpMetadata =>
  baseFakeMeta({ id, completedAt, startedAt: completedAt - 1, model: 'model-a', responseBytes: 4 });

const readFrames = async (response: Response, count: number): Promise<string[]> => {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const collected: string[] = [];
  let buffer = '';
  while (collected.length < count) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    while (buffer.includes('\n\n')) {
      const index = buffer.indexOf('\n\n');
      collected.push(buffer.slice(0, index));
      buffer = buffer.slice(index + 2);
      if (collected.length >= count) break;
    }
  }
  void reader.cancel();
  return collected;
};

const parseSseFrame = (frame: string): { event: string; data: unknown } => {
  let event = 'message';
  let data = '';
  for (const line of frame.split('\n')) {
    if (line.startsWith('event: ')) event = line.slice(7);
    else if (line.startsWith('data: ')) data = line.slice(6);
  }
  return { event, data: JSON.parse(data) };
};

class MemoryLogStream implements LogStream {
  private readonly chunks: Uint8Array[] = [];
  private ended = false;
  private readonly wakeups = new Set<() => void>();

  async append(_atOffset: number, bytes: Uint8Array): Promise<void> {
    this.chunks.push(bytes.slice());
    for (const wake of this.wakeups) wake();
    this.wakeups.clear();
  }

  async end(): Promise<void> {
    this.ended = true;
    for (const wake of this.wakeups) wake();
    this.wakeups.clear();
  }

  read(_fromOffset: number, signal: AbortSignal): AsyncIterable<Uint8Array> {
    let index = 0;
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          signal.throwIfAborted();
          while (index < self.chunks.length) yield self.chunks[index++]!;
          if (self.ended) return;
          await new Promise<void>(resolve => {
            const wake = (): void => {
              self.wakeups.delete(wake);
              signal.removeEventListener('abort', wake);
              resolve();
            };
            self.wakeups.add(wake);
            signal.addEventListener('abort', wake, { once: true });
          });
        }
      },
    };
  }
}

const installLiveStream = async (keyId: string, recordId: string): Promise<MemoryLogStream> => {
  const streams = new Map<string, MemoryLogStream>();
  const stream = new MemoryLogStream();
  streams.set(dumpLiveStreamId(keyId, recordId), stream);
  const store: LogStreamStore = {
    async open(streamId) {
      const existing = streams.get(streamId);
      if (existing !== undefined) return existing;
      const created = new MemoryLogStream();
      streams.set(streamId, created);
      return created;
    },
    async get(streamId) { return streams.get(streamId) ?? null; },
  };
  initLogStreamStore(store);
  return stream;
};

test('GET /api/dump/keys/:keyId/records 404s when the key has no retention', async () => {
  const { apiKey } = await setupAppTest();
  installDumpStubs(initDumpStore, initDumpBroker);
  const response = await requestApp(`/api/dump/keys/${apiKey.id}/records`, {
    headers: { 'x-api-key': apiKey.key },
  });
  assertEquals(response.status, 404);
});

test('dump record detail and artifact use metadata-only v2 records', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: 3600 });
  const stubs = installDumpStubs(initDumpStore, initDumpBroker);
  const artifactKey = stubs.store.createArtifactKey(apiKey.id, 1000, 'record-a');
  const artifact = new TextEncoder().encode('{"k":"run"}\n');
  await stubs.store.stageAndPutArtifact(apiKey.id, 'record-a', artifactKey, new ReadableStream({
    start(controller) { controller.enqueue(artifact); controller.close(); },
  }));
  const meta = fakeMeta('record-a', 2000);
  await stubs.store.commitRecord(apiKey.id, { meta, artifactKey });

  const detail = await requestApp(`/api/dump/keys/${apiKey.id}/records/record-a`, {
    headers: { 'x-api-key': apiKey.key },
  });
  assertEquals(detail.status, 200);
  assertEquals(await detail.json(), { meta });

  const response = await requestApp(`/api/dump/keys/${apiKey.id}/records/record-a/artifact`, {
    headers: { 'x-api-key': apiKey.key },
  });
  assertEquals(response.status, 200);
  assertEquals(response.headers.get('content-type'), 'application/x-ndjson; charset=utf-8');
  assertEquals(await response.text(), '{"k":"run"}\n');
});

test('dump live route resumes the registered log stream at the requested offset', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: 3600 });
  installDumpStubs(initDumpStore, initDumpBroker);
  const stream = await installLiveStream(apiKey.id, 'record-live');
  await stream.append(0, new TextEncoder().encode('{"one":1}\n'));
  await stream.end();

  const response = await requestApp(`/api/dump/keys/${apiKey.id}/records/record-live/live?offset=0`, {
    headers: { 'x-api-key': apiKey.key },
  });
  assertEquals(response.status, 200);
  const chunks: Uint8Array[] = [];
  for await (const chunk of readLogStream(response)) chunks.push(chunk);
  assertEquals(new TextDecoder().decode(chunks[0]), '{"one":1}\n');
});

test('GET /api/dump/keys/:keyId/stream emits event: error when broker throws mid-stream', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: 3600 });
  const stubs = installDumpStubs(initDumpStore, initDumpBroker);
  initDumpBroker({
    ...stubs.broker,
    subscribe() {
      return (async function*() { throw new Error('broker exploded'); })();
    },
  });
  const response = await requestApp(`/api/dump/keys/${apiKey.id}/stream`, {
    headers: { 'x-api-key': apiKey.key },
  });
  assertEquals(response.status, 200);
  const frames = await readFrames(response, 2);
  assertExists(frames.find(frame => frame.includes('event: error') && frame.includes('broker exploded')));
});

test('dump SSE delivers started and appended frames published between snapshot and subscription consumption', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: 3600 });
  const stubs = installDumpStubs(initDumpStore, initDumpBroker);
  let releaseSnapshot: (() => void) | null = null;
  const snapshotGate = new Promise<void>(resolve => { releaseSnapshot = resolve; });
  let onSubscribed: (() => void) | null = null;
  const subscribed = new Promise<void>(resolve => { onSubscribed = resolve; });
  const slowStore: DumpStore = {
    ...stubs.store,
    list: async (keyId, opts) => {
      await snapshotGate;
      return await stubs.store.list(keyId, opts);
    },
  };
  initDumpStore(slowStore);
  initDumpBroker({
    ...stubs.broker,
    subscribe: (keyId, signal) => {
      const iterator = stubs.broker.subscribe(keyId, signal);
      onSubscribed!();
      return iterator;
    },
  });

  const responsePromise = requestApp(`/api/dump/keys/${apiKey.id}/stream`, {
    headers: { 'x-api-key': apiKey.key },
  });
  await subscribed;
  await stubs.broker.publish(apiKey.id, {
    event: 'started',
    data: { id: 'record-start', startedAt: 1, method: 'POST', path: '/v1/x', model: 'model-a', requestBytes: 2 },
  });
  await stubs.broker.publish(apiKey.id, { event: 'appended', data: fakeMeta('record-done', 2) });
  releaseSnapshot!();

  const response = await responsePromise;
  const frames = (await readFrames(response, 3)).map(parseSseFrame);
  assertEquals(frames.map(frame => frame.event), ['snapshot', 'started', 'appended']);
  assertEquals((frames[1]!.data as { id: string }).id, 'record-start');
  assertEquals((frames[2]!.data as { id: string }).id, 'record-done');
});
