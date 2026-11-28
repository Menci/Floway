import { test, vi } from 'vitest';

import { initDumpBroker, initDumpStore } from '../../src/dump/registry.ts';
import type { DumpStore } from '../../src/dump/store-contract.ts';
import type { DumpMetadata, StoredDumpRecord } from '../../src/dump/types.ts';
import { fakeMeta as baseFakeMeta, fakeRecord as baseFakeRecord, installDumpStubs } from '../dump/test-fixtures.ts';
import { requestApp, setupAppTest } from '../test-utils/app.ts';
import { assertEquals, assertExists } from '@floway-dev/test-utils';

const fakeMeta = (id: string, completedAt: number): DumpMetadata =>
  baseFakeMeta({ id, completedAt, startedAt: completedAt - 1 });

const fakeRecord = (id: string, completedAt: number): StoredDumpRecord =>
  baseFakeRecord({ id, completedAt, startedAt: completedAt - 1 });

test('GET /api/dump/keys/:keyId/records 404s when the key has no retention', async () => {
  const { apiKey } = await setupAppTest();
  installDumpStubs(initDumpStore, initDumpBroker);

  const response = await requestApp(`/api/dump/keys/${apiKey.id}/records`, {
    headers: { 'x-api-key': apiKey.key },
  });
  assertEquals(response.status, 404);
});

test('GET /api/dump/keys/:keyId/records defaults an absent limit and coerces a supplied one', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: 3600 });
  const { store } = installDumpStubs(initDumpStore, initDumpBroker);
  const list = vi.fn(store.list);
  initDumpStore({ ...store, list });

  const path = `/api/dump/keys/${apiKey.id}/records`;
  const request = { headers: { 'x-api-key': apiKey.key } };
  assertEquals((await requestApp(path, request)).status, 200);
  assertEquals((await requestApp(`${path}?limit=2`, request)).status, 200);
  assertEquals(list.mock.calls.map(([, options]) => options.limit), [100, 2]);
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

// A cursor over one SSE response that survives several reads: each frame the
// stream emits is consumed once, in order, so a test can wait for the snapshot
// and then for individual appended frames.
const frameReader = (response: Response) => {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  return async (count: number): Promise<string[]> => {
    const collected: string[] = [];
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
    return collected;
  };
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

interface OwnedKey {
  id: string;
  name: string;
  key: string;
}

const ownedMeta = (id: string, completedAt: number, owner: OwnedKey, overrides: Partial<DumpMetadata> = {}): DumpMetadata =>
  baseFakeMeta({
    id, completedAt, startedAt: completedAt - 1,
    key: { id: owner.id, name: owner.name, suffix: owner.key.slice(-4) },
    ...overrides,
  });

const ownedRecord = (id: string, completedAt: number, owner: OwnedKey, overrides: Partial<DumpMetadata> = {}): StoredDumpRecord =>
  baseFakeRecord({
    id, completedAt, startedAt: completedAt - 1,
    key: { id: owner.id, name: owner.name, suffix: owner.key.slice(-4) },
    ...overrides,
  });

const savedKey = (userId: number, id: string, name: string, key: string) => ({
  userId,
  id,
  name,
  key,
  serverSecret: '11'.repeat(32),
  createdAt: '2026-03-15T00:00:00.000Z',
  upstreamIds: null,
  randomizeUpstreams: false,
  deletedAt: null,
  dumpRetentionSeconds: 3600,
  openaiResponsesRetentionSeconds: 0,
});

test('GET /api/dump/records merges every owned dump key', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: 3600 });
  const other = savedKey(apiKey.userId, 'key_second', 'Second key', 'raw_second_key');
  await repo.apiKeys.save(other);
  const stubs = installDumpStubs(initDumpStore, initDumpBroker);
  stubs.seed(apiKey.id, ownedRecord('01HZZ0000000000000000000K1', 1000, apiKey));
  stubs.seed(other.id, ownedRecord('01HZZ0000000000000000000K2', 2000, other));

  const response = await requestApp('/api/dump/records', { headers: { 'x-api-key': apiKey.key } });
  assertEquals(response.status, 200);
  const body = await response.json() as { records: DumpMetadata[] };
  assertEquals(body.records.map(record => record.id), ['01HZZ0000000000000000000K2', '01HZZ0000000000000000000K1']);
  assertEquals(body.records.map(record => record.key.id), [other.id, apiKey.id]);
  // The suffix is the stored key's last four characters; the key itself never
  // reaches the metadata.
  assertEquals(body.records[0]!.key.suffix, other.key.slice(-4));
});

test('GET /api/dump/records applies the list filters to the merged page', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: 3600 });
  const other = savedKey(apiKey.userId, 'key_second', 'Second key', 'raw_second_key');
  await repo.apiKeys.save(other);
  const stubs = installDumpStubs(initDumpStore, initDumpBroker);
  stubs.seed(apiKey.id, ownedRecord('01HZZ0000000000000000000F1', 1000, apiKey));
  stubs.seed(other.id, ownedRecord('01HZZ0000000000000000000F2', 2000, other, { model: 'needle-model', status: 500 }));
  stubs.seed(other.id, ownedRecord('01HZZ0000000000000000000F3', 3000, other, { model: 'needle-model' }));

  const response = await requestApp('/api/dump/records?q=needle&failures=true', { headers: { 'x-api-key': apiKey.key } });
  assertEquals(response.status, 200);
  const body = await response.json() as { records: DumpMetadata[] };
  assertEquals(body.records.map(record => record.id), ['01HZZ0000000000000000000F2']);
});

test('GET /api/dump/records/:recordId resolves a record from another owned key', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: 3600 });
  const other = savedKey(apiKey.userId, 'key_second', 'Second key', 'raw_second_key');
  await repo.apiKeys.save(other);
  const stubs = installDumpStubs(initDumpStore, initDumpBroker);
  stubs.seed(other.id, ownedRecord('01HZZ0000000000000000000D1', 1000, other));

  const response = await requestApp('/api/dump/records/01HZZ0000000000000000000D1', { headers: { 'x-api-key': apiKey.key } });
  assertEquals(response.status, 200);
  const body = await response.json() as { meta: DumpMetadata };
  assertEquals(body.meta.key.id, other.id);

  const missing = await requestApp('/api/dump/records/01HZZ0000000000000000000ZZ', { headers: { 'x-api-key': apiKey.key } });
  assertEquals(missing.status, 404);
});

test('GET /api/dump/records drops a key whose retention was disabled', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: 3600 });
  const other = savedKey(apiKey.userId, 'key_second', 'Second key', 'raw_second_key');
  await repo.apiKeys.save(other);
  const stubs = installDumpStubs(initDumpStore, initDumpBroker);
  stubs.seed(other.id, ownedRecord('01HZZ0000000000000000000R1', 1000, other));
  await repo.apiKeys.update(other.id, { dumpRetentionSeconds: null });

  const response = await requestApp('/api/dump/records', { headers: { 'x-api-key': apiKey.key } });
  assertEquals(response.status, 200);
  const body = await response.json() as { records: DumpMetadata[] };
  assertEquals(body.records, []);
});

test('GET /api/dump/records never includes another user\'s key', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: 3600 });
  // The default fixture key belongs to user 2; a key on user 1 must stay out of
  // the caller's merged log in both directions.
  const adminOwn = savedKey(1, 'key_admin', 'Admin key', 'raw_admin_key');
  await repo.apiKeys.save(adminOwn);
  const stubs = installDumpStubs(initDumpStore, initDumpBroker);
  stubs.seed(apiKey.id, ownedRecord('01HZZ0000000000000000000W2', 2000, apiKey));
  stubs.seed(adminOwn.id, ownedRecord('01HZZ0000000000000000000W1', 1000, adminOwn));

  const response = await requestApp('/api/dump/records', { headers: { 'x-api-key': apiKey.key } });
  assertEquals(response.status, 200);
  const body = await response.json() as { records: DumpMetadata[] };
  assertEquals(body.records.map(record => record.id), ['01HZZ0000000000000000000W2']);

  const foreign = await requestApp('/api/dump/records/01HZZ0000000000000000000W1', { headers: { 'x-api-key': apiKey.key } });
  assertEquals(foreign.status, 404);
});

test('GET /api/dump/records scopes an administrator session to their own keys', async () => {
  const { repo, apiKey, adminSession } = await setupAppTest();
  // A key owned by the signed-in admin (user 1), plus the fixture key owned by
  // user 2 that the session must not see.
  const own = savedKey(1, 'key_admin', 'Admin key', 'raw_admin_key');
  await repo.apiKeys.save(own);
  const stubs = installDumpStubs(initDumpStore, initDumpBroker);
  stubs.seed(own.id, ownedRecord('01HZZ0000000000000000000W1', 1000, own));
  stubs.seed(apiKey.id, ownedRecord('01HZZ0000000000000000000W2', 2000, apiKey));

  const response = await requestApp('/api/dump/records', { headers: { 'x-floway-session': adminSession } });
  assertEquals(response.status, 200);
  const body = await response.json() as { records: DumpMetadata[] };
  assertEquals(body.records.map(record => record.id), ['01HZZ0000000000000000000W1']);
});

test('GET /api/dump/stream merges snapshots and appended frames from every key', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: 3600 });
  const other = savedKey(apiKey.userId, 'key_second', 'Second key', 'raw_second_key');
  await repo.apiKeys.save(other);
  const stubs = installDumpStubs(initDumpStore, initDumpBroker);
  stubs.seed(apiKey.id, ownedRecord('01HZZ0000000000000000000U1', 1000, apiKey));
  stubs.seed(other.id, ownedRecord('01HZZ0000000000000000000U2', 2000, other));

  const response = await requestApp('/api/dump/stream', { headers: { 'x-api-key': apiKey.key } });
  assertEquals(response.status, 200);
  await stubs.broker.publish(apiKey.id, ownedMeta('01HZZ0000000000000000000U3', 3000, apiKey));
  await stubs.broker.publish(other.id, ownedMeta('01HZZ0000000000000000000U4', 4000, other));

  const frames = await readFrames(response, 3);
  const snapshot = frames.map(parseSseFrame).find(frame => frame.event === 'snapshot');
  assertExists(snapshot);
  const snapshotData = snapshot.data as { records: { id: string }[] };
  assertEquals(snapshotData.records.map(record => record.id), ['01HZZ0000000000000000000U2', '01HZZ0000000000000000000U1']);
  const appended = frames.map(parseSseFrame).filter(frame => frame.event === 'appended').map(frame => (frame.data as { id: string }).id);
  assertEquals(appended.sort(), ['01HZZ0000000000000000000U3', '01HZZ0000000000000000000U4']);
});

test('GET /api/dump/stream keeps the other keys flowing when one channel closes', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: 3600 });
  const other = savedKey(apiKey.userId, 'key_second', 'Second key', 'raw_second_key');
  await repo.apiKeys.save(other);
  const stubs = installDumpStubs(initDumpStore, initDumpBroker);
  stubs.seed(apiKey.id, ownedRecord('01HZZ0000000000000000000V1', 1000, apiKey));

  const response = await requestApp('/api/dump/stream', { headers: { 'x-api-key': apiKey.key } });
  const read = frameReader(response);
  const snapshot = parseSseFrame((await read(1))[0]!);
  assertEquals(snapshot.event, 'snapshot');

  await stubs.broker.closeChannel(apiKey.id, 'retention disabled');
  await stubs.broker.publish(other.id, ownedMeta('01HZZ0000000000000000000V2', 2000, other));
  await stubs.broker.publish(apiKey.id, ownedMeta('01HZZ0000000000000000000V3', 3000, apiKey));

  const appended = parseSseFrame((await read(1))[0]!);
  assertEquals(appended.event, 'appended');
  assertEquals((appended.data as { id: string }).id, '01HZZ0000000000000000000V2');
});

test('GET /api/dump/stream filters live frames the way the search filters the snapshot', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: 3600 });
  const other = savedKey(apiKey.userId, 'key_second', 'Second key', 'raw_second_key');
  await repo.apiKeys.save(other);
  const stubs = installDumpStubs(initDumpStore, initDumpBroker);

  const response = await requestApp('/api/dump/stream?q=needle', { headers: { 'x-api-key': apiKey.key } });
  const read = frameReader(response);
  await read(1);
  await stubs.broker.publish(apiKey.id, ownedMeta('01HZZ0000000000000000000X1', 1000, apiKey));
  await stubs.broker.publish(apiKey.id, ownedMeta('01HZZ0000000000000000000X2', 2000, apiKey, { model: 'needle-model' }));

  const appended = parseSseFrame((await read(1))[0]!);
  assertEquals((appended.data as { id: string }).id, '01HZZ0000000000000000000X2');
});

test('GET /api/dump/stream lets a key-name match through, as the snapshot search does', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: 3600 });
  const other = savedKey(apiKey.userId, 'key_second', 'Second key', 'raw_second_key');
  await repo.apiKeys.save(other);
  const stubs = installDumpStubs(initDumpStore, initDumpBroker);

  const response = await requestApp('/api/dump/stream?q=second%20key', { headers: { 'x-api-key': apiKey.key } });
  const read = frameReader(response);
  await read(1);
  await stubs.broker.publish(apiKey.id, ownedMeta('01HZZ0000000000000000000W1', 1000, apiKey));
  // Nothing but the source key's name matches the search.
  await stubs.broker.publish(other.id, ownedMeta('01HZZ0000000000000000000W2', 2000, other));
  // A later frame on the same channel that its model also matches, so a
  // filter that skipped the key name fails on the wrong id instead of waiting
  // for a frame that never comes.
  await stubs.broker.publish(other.id, ownedMeta('01HZZ0000000000000000000W3', 3000, other, { model: 'second key model' }));

  const appended = parseSseFrame((await read(1))[0]!);
  assertEquals((appended.data as { id: string }).id, '01HZZ0000000000000000000W2');
});

test('GET /api/dump/stream does not let a suffix-only match through', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: 3600 });
  const other = savedKey(apiKey.userId, 'key_second', 'Second key', 'raw-abcdefgh');
  await repo.apiKeys.save(other);
  const stubs = installDumpStubs(initDumpStore, initDumpBroker);

  // `efgh` is the key's display tail and nothing else. The snapshot's SQL
  // search does not cover the suffix, so neither may the live filter.
  const response = await requestApp('/api/dump/stream?q=efgh', { headers: { 'x-api-key': apiKey.key } });
  const read = frameReader(response);
  await read(1);
  await stubs.broker.publish(other.id, ownedMeta('01HZZ0000000000000000000Z1', 1000, other));
  // A frame the same stream does keep proves the filter ran rather than the
  // connection having stalled.
  await stubs.broker.publish(other.id, ownedMeta('01HZZ0000000000000000000Z2', 2000, other, { model: 'efgh-model' }));

  const appended = parseSseFrame((await read(1))[0]!);
  assertEquals((appended.data as { id: string }).id, '01HZZ0000000000000000000Z2');
});

test('GET /api/dump/records search matches the key name but not its suffix', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: 3600 });
  const other = savedKey(apiKey.userId, 'key_second', 'Second key', 'raw-abcdefgh');
  await repo.apiKeys.save(other);
  const stubs = installDumpStubs(initDumpStore, initDumpBroker);
  stubs.seed(other.id, ownedRecord('01HZZ0000000000000000000Y1', 1000, other));

  const byName = await requestApp('/api/dump/records?q=second', { headers: { 'x-api-key': apiKey.key } });
  assertEquals(((await byName.json()) as { records: DumpMetadata[] }).records.map(record => record.id), ['01HZZ0000000000000000000Y1']);
  // The live stream matches exactly these fields, so a suffix-only hit would
  // make the snapshot and the appended frames disagree.
  const bySuffix = await requestApp('/api/dump/records?q=efgh', { headers: { 'x-api-key': apiKey.key } });
  assertEquals(((await bySuffix.json()) as { records: DumpMetadata[] }).records, []);
});

test('GET /api/dump/stream accepts the dashboard EventSource session in the query', async () => {
  const { repo, adminSession } = await setupAppTest();
  const own = savedKey(1, 'key_admin', 'Admin key', 'raw_admin_key');
  await repo.apiKeys.save(own);
  const stubs = installDumpStubs(initDumpStore, initDumpBroker);
  stubs.seed(own.id, ownedRecord('01HZZ0000000000000000000E1', 1000, own));

  const response = await requestApp(`/api/dump/stream?session=${encodeURIComponent(adminSession)}`, {});
  assertEquals(response.status, 200);
  const snapshot = parseSseFrame((await readFrames(response, 1))[0]!);
  assertEquals(snapshot.event, 'snapshot');
  assertEquals((snapshot.data as { records: { id: string }[] }).records.map(record => record.id), ['01HZZ0000000000000000000E1']);
});
