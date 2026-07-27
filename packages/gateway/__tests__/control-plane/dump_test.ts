import { test } from 'vitest';

import { initDumpBroker, initDumpStore } from '../../src/dump/registry.ts';
import type { DumpStore } from '../../src/dump/store-contract.ts';
import type { DumpMetadata, DumpRecord, StoredDumpRecord } from '../../src/dump/types.ts';
import { fakeMeta as baseFakeMeta, fakeRecord as baseFakeRecord, installDumpStubs } from '../dump/test-fixtures.ts';
import { requestApp, setupAppTest } from '../test-utils/app.ts';
import { assertEquals, assertExists } from '@floway-dev/test-utils';

const fakeMeta = (id: string, completedAt: number): DumpMetadata =>
  baseFakeMeta({ id, completedAt, startedAt: completedAt - 1 });

const fakeRecord = (id: string, completedAt: number): StoredDumpRecord =>
  baseFakeRecord({ id, completedAt, startedAt: completedAt - 1 });

test('GET /api/dump/keys/:keyId/records lists newest-first', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: 3600 });
  const stubs = installDumpStubs(initDumpStore, initDumpBroker);
  stubs.seed(apiKey.id, fakeRecord('01HZZ0000000000000000000A1', 1000));
  stubs.seed(apiKey.id, fakeRecord('01HZZ0000000000000000000A2', 2000));

  const response = await requestApp(`/api/dump/keys/${apiKey.id}/records`, {
    headers: { 'x-api-key': apiKey.key },
  });
  assertEquals(response.status, 200);
  const body = await response.json() as { records: DumpMetadata[] };
  assertEquals(body.records.length, 2);
  assertEquals(body.records[0]!.id, '01HZZ0000000000000000000A2');
});

test('GET /api/dump/keys/:keyId/records paginates via ?before=', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: 3600 });
  const stubs = installDumpStubs(initDumpStore, initDumpBroker);
  stubs.seed(apiKey.id, fakeRecord('01HZZ0000000000000000000A1', 1000));
  stubs.seed(apiKey.id, fakeRecord('01HZZ0000000000000000000A2', 2000));

  const response = await requestApp(`/api/dump/keys/${apiKey.id}/records?before=01HZZ0000000000000000000A2`, {
    headers: { 'x-api-key': apiKey.key },
  });
  assertEquals(response.status, 200);
  const body = await response.json() as { records: DumpMetadata[] };
  assertEquals(body.records.length, 1);
  assertEquals(body.records[0]!.id, '01HZZ0000000000000000000A1');
});

test('GET /api/dump/keys/:keyId/records rejects fractional limit', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: 3600 });
  installDumpStubs(initDumpStore, initDumpBroker);

  const response = await requestApp(`/api/dump/keys/${apiKey.id}/records?limit=1.5`, {
    headers: { 'x-api-key': apiKey.key },
  });
  assertEquals(response.status, 400);
});

test('GET /api/dump/keys/:keyId/records 404s when the key has no retention', async () => {
  const { apiKey } = await setupAppTest();
  installDumpStubs(initDumpStore, initDumpBroker);

  const response = await requestApp(`/api/dump/keys/${apiKey.id}/records`, {
    headers: { 'x-api-key': apiKey.key },
  });
  assertEquals(response.status, 404);
});

test('GET /api/dump/keys/:keyId/records/:recordId returns the rehydrated record', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: 3600 });
  const stubs = installDumpStubs(initDumpStore, initDumpBroker);
  stubs.seed(apiKey.id, fakeRecord('01HZZ0000000000000000000XX', 1000));

  const response = await requestApp(`/api/dump/keys/${apiKey.id}/records/01HZZ0000000000000000000XX`, {
    headers: { 'x-api-key': apiKey.key },
  });
  assertEquals(response.status, 200);
  const body = await response.json() as DumpRecord;
  assertEquals(body.meta.id, '01HZZ0000000000000000000XX');
});

test('GET /api/dump/keys/:keyId/records/:recordId 404s on unknown id', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: 3600 });
  installDumpStubs(initDumpStore, initDumpBroker);

  const response = await requestApp(`/api/dump/keys/${apiKey.id}/records/01HZZ0000000000000000000ZZ`, {
    headers: { 'x-api-key': apiKey.key },
  });
  assertEquals(response.status, 404);
});

// Read N SSE frames (`\n\n` delimited) off the response body. A deterministic
// barrier — no timeout — that returns as soon as the requested count lands.
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
      const idx = buffer.indexOf('\n\n');
      collected.push(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 2);
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

test('GET /api/dump/keys/:keyId/stream sends snapshot then appended frames', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: 3600 });
  const stubs = installDumpStubs(initDumpStore, initDumpBroker);
  stubs.seed(apiKey.id, fakeRecord('01HZZ0000000000000000000A1', 1000));

  // requestApp resolves after the snapshot frame is buffered onto the wire;
  // the subscribe is already armed at that point, so the subsequent publish
  // is guaranteed to surface as an appended frame on the next pump.
  const response = await requestApp(`/api/dump/keys/${apiKey.id}/stream`, {
    headers: { 'x-api-key': apiKey.key },
  });
  assertEquals(response.status, 200);
  await stubs.broker.publish(apiKey.id, fakeMeta('01HZZ0000000000000000000A2', 2000));

  const frames = await readFrames(response, 2);
  const snapshot = parseSseFrame(frames[0]!);
  assertEquals(snapshot.event, 'snapshot');
  assertEquals((snapshot.data as { records: { id: string }[] }).records[0]!.id, '01HZZ0000000000000000000A1');
  const appended = parseSseFrame(frames[1]!);
  assertEquals(appended.event, 'appended');
  assertEquals((appended.data as { id: string }).id, '01HZZ0000000000000000000A2');
});

test('GET /api/dump/keys/:keyId/stream emits event: error when broker throws mid-stream', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: 3600 });
  const stubs = installDumpStubs(initDumpStore, initDumpBroker);
  initDumpBroker({
    ...stubs.broker,
    subscribe(_keyId, _signal) {
      return (async function*() {
        throw new Error('broker exploded');
      })();
    },
  });

  const response = await requestApp(`/api/dump/keys/${apiKey.id}/stream`, {
    headers: { 'x-api-key': apiKey.key },
  });
  assertEquals(response.status, 200);

  const frames = await readFrames(response, 2);
  assertExists(frames.find(frame => frame.includes('event: error') && frame.includes('broker exploded')));
});

test('GET /api/dump/keys/:keyId/stream delivers a frame appended between snapshot SELECT and subscribe arm', async () => {
  // A record published during the snapshot read must surface as an `appended`
  // frame after the snapshot frame — proving the subscribe was already armed
  // when the publish landed (so the buffered-subscribe path delivered it
  // rather than the snapshot picking it up post-hoc).
  const { repo, apiKey } = await setupAppTest();
  await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: 3600 });
  const stubs = installDumpStubs(initDumpStore, initDumpBroker);
  // Hold the snapshot read on a gate so the publish lands in the window
  // between subscribe-arm and snapshot-return; release the gate only after
  // the publish completes. Also wrap subscribe so the test can wait for the
  // handler to arm before publishing — without that, a publish run before
  // subscribe is registered goes nowhere.
  let releaseSnapshot: (() => void) | null = null;
  const snapshotGate = new Promise<void>(resolve => { releaseSnapshot = resolve; });
  let onSubscribed: (() => void) | null = null;
  const subscribedSignal = new Promise<void>(resolve => { onSubscribed = resolve; });
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
      const iter = stubs.broker.subscribe(keyId, signal);
      onSubscribed!();
      return iter;
    },
  });
  stubs.seed(apiKey.id, fakeRecord('01HZZ0000000000000000000A1', 1000));

  const responsePromise = requestApp(`/api/dump/keys/${apiKey.id}/stream`, {
    headers: { 'x-api-key': apiKey.key },
  });
  await subscribedSignal;
  await stubs.broker.publish(apiKey.id, fakeMeta('01HZZ0000000000000000000A2', 2000));
  releaseSnapshot!();

  const response = await responsePromise;
  const frames = await readFrames(response, 2);
  const snapshot = frames.find(f => f.includes('event: snapshot'));
  const appended = frames.find(f => f.includes('event: appended'));
  assertExists(snapshot);
  assertExists(appended);
  // The published id is not in the snapshot — proves the snapshot SELECT ran
  // before the publish landed in the store.
  const snapshotIds = (parseSseFrame(snapshot).data as { records: { id: string }[] }).records.map(r => r.id);
  assertEquals(snapshotIds.includes('01HZZ0000000000000000000A2'), false);
  // The published id arrived as an appended frame — proves the subscribe
  // was armed before the publish, so the buffered-subscribe path delivered
  // it.
  assertEquals((parseSseFrame(appended).data as { id: string }).id, '01HZZ0000000000000000000A2');
});
