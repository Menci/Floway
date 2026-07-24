import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref } from 'vue';

import { useDumpSubscription } from './useDumpSubscription.ts';
import { useAuthStore } from '../stores/auth.ts';
import type { DumpMetadata } from '@floway-dev/gateway/dump-types';

// Minimal EventSource shim mirroring the surface the composable touches:
// `addEventListener('snapshot' | 'appended' | 'error')`, `readyState`, `close`,
// `url`. `emit()` lets each test drive the stream by hand. Installed as the
// global `EventSource` for the test environment so the composable picks it up
// without any DI hook.
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static lastUrl: string | null = null;
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  readyState = 0;
  url: string;
  closed = false;
  private listeners = new Map<string, Array<(ev: unknown) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.lastUrl = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (ev: unknown) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  close() {
    this.closed = true;
    this.readyState = 2;
  }

  emit(type: string, data?: unknown) {
    for (const fn of this.listeners.get(type) ?? []) fn({ data, type });
  }

  emitClose() {
    this.readyState = 2;
    this.emit('error', '');
  }

  emitTransientBlip() {
    this.readyState = 0;
    this.emit('error', '');
  }
}

const meta = (id: string, overrides: Partial<DumpMetadata> = {}): DumpMetadata => ({
  id,
  startedAt: 0,
  completedAt: 0,
  method: 'POST',
  path: '/v1/chat/completions',
  status: 200,
  upstream: null,
  model: 'gpt-4o',
  inputTokens: null,
  outputTokens: null,
  requestBytes: 0,
  responseBytes: 0,
  durationMs: 0,
  error: null,
  ...overrides,
});

const newest = (n: number) => meta(`r-${n.toString().padStart(3, '0')}`);

let fetchMock: ReturnType<typeof vi.fn>;

const setup = () => {
  FakeEventSource.instances = [];
  FakeEventSource.lastUrl = null;
  fetchMock = vi.fn();
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('fetch', fetchMock);
  setActivePinia(createPinia());
  useAuthStore().setAuth({
    token: 'tok-abc',
    user: {
      id: 1,
      username: 'op',
      isAdmin: true,
      upstreamIds: null,
    },
  });
  const scope = effectScope();
  return { scope };
};

beforeEach(() => setup());
afterEach(() => vi.unstubAllGlobals());

describe('useDumpSubscription', () => {
  it('is a no-op when keyId is empty', () => {
    const { scope } = setup();
    const keyId = ref('');
    const sub = scope.run(() => useDumpSubscription(keyId))!;
    expect(FakeEventSource.instances.length).toBe(0);
    expect(sub.records.value).toEqual([]);
    expect(sub.loading.value).toBe(false);
    scope.stop();
  });

  it('opens an EventSource and rebuilds records from the snapshot', () => {
    const { scope } = setup();
    const keyId = ref('key1');
    const sub = scope.run(() => useDumpSubscription(keyId))!;

    expect(FakeEventSource.instances.length).toBe(1);
    expect(FakeEventSource.lastUrl).toContain('/api/dump/keys/key1/stream?session=tok-abc');
    expect(sub.loading.value).toBe(true);

    FakeEventSource.instances[0]!.emit('snapshot', JSON.stringify({
      records: [newest(5), newest(4), newest(3)],
    }));

    expect(sub.records.value.map(r => r.id)).toEqual(['r-005', 'r-004', 'r-003']);
    expect(sub.loading.value).toBe(false);
    expect(sub.error.value).toBeNull();
    scope.stop();
  });

  it('snapshot rebuild preserves paged-in older records when the snapshot tail is no longer in memory', async () => {
    // Long-tail scenario: after the operator paged backward, a second snapshot
    // arrives that covers a strictly-newer range than what memory holds. The
    // paged-in tail (older than the new snapshot's oldest) must survive —
    // id-comparison is the source of truth, since ULIDs sort lexically by
    // creation time. Two snapshot frames on the same EventSource — no actual
    // reconnect; just two emissions simulating a fresher view from the server.
    const { scope } = setup();
    const keyId = ref('key1');
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ records: [newest(2), newest(1)] }) });
    const sub = scope.run(() => useDumpSubscription(keyId))!;

    FakeEventSource.instances[0]!.emit('snapshot', JSON.stringify({
      records: [newest(5), newest(4), newest(3)],
    }));
    await sub.loadOlder();
    expect(sub.records.value.map(r => r.id)).toEqual(['r-005', 'r-004', 'r-003', 'r-002', 'r-001']);

    // Second snapshot has no overlap with memory and whose oldest id (r-006)
    // is newer than every paged-in row.
    FakeEventSource.instances[0]!.emit('snapshot', JSON.stringify({
      records: [newest(10), newest(9), newest(8), newest(7), newest(6)],
    }));
    expect(sub.records.value.map(r => r.id)).toEqual([
      'r-010', 'r-009', 'r-008', 'r-007', 'r-006',
      'r-005', 'r-004', 'r-003', 'r-002', 'r-001',
    ]);
    scope.stop();
  });

  it('snapshot rebuild merges paged-in older records when a fresher snapshot arrives', async () => {
    // Two snapshot frames on the same EventSource (not a real reconnect — the
    // socket stays the same; only the snapshot payload changes). The paged-in
    // r-002/r-001 must survive the second snapshot's rebuild.
    const { scope } = setup();
    const keyId = ref('key1');
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ records: [newest(2), newest(1)] }) })
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ records: [] }) });
    const sub = scope.run(() => useDumpSubscription(keyId))!;

    FakeEventSource.instances[0]!.emit('snapshot', JSON.stringify({
      records: [newest(5), newest(4), newest(3)],
    }));
    await sub.loadOlder();
    expect(sub.records.value.map(r => r.id)).toEqual(['r-005', 'r-004', 'r-003', 'r-002', 'r-001']);

    // Second snapshot frame (with a new record on top) — the paged-in
    // r-002/r-001 must survive.
    FakeEventSource.instances[0]!.emit('snapshot', JSON.stringify({
      records: [newest(6), newest(5), newest(4), newest(3)],
    }));
    expect(sub.records.value.map(r => r.id)).toEqual(['r-006', 'r-005', 'r-004', 'r-003', 'r-002', 'r-001']);
    scope.stop();
  });

  it('dedups by id on appended events', () => {
    const { scope } = setup();
    const keyId = ref('key1');
    const sub = scope.run(() => useDumpSubscription(keyId))!;
    FakeEventSource.instances[0]!.emit('snapshot', JSON.stringify({ records: [newest(1)] }));
    FakeEventSource.instances[0]!.emit('appended', JSON.stringify(newest(2)));
    FakeEventSource.instances[0]!.emit('appended', JSON.stringify(newest(2)));
    expect(sub.records.value.map(r => r.id)).toEqual(['r-002', 'r-001']);
    scope.stop();
  });

  it('surfaces server-sent error frames to error.value', () => {
    const { scope } = setup();
    const keyId = ref('key1');
    const sub = scope.run(() => useDumpSubscription(keyId))!;
    FakeEventSource.instances[0]!.emit('error', JSON.stringify({ message: 'broker exploded' }));
    expect(sub.error.value).toBe('broker exploded');
    scope.stop();
  });

  it('falls back to "Stream disconnected" when transport closes with no payload', () => {
    const { scope } = setup();
    const keyId = ref('key1');
    const sub = scope.run(() => useDumpSubscription(keyId))!;
    FakeEventSource.instances[0]!.emitClose();
    expect(sub.error.value).toBe('Stream disconnected');
    scope.stop();
  });

  it('ignores transient transport blips during auto-reconnect', () => {
    const { scope } = setup();
    const keyId = ref('key1');
    const sub = scope.run(() => useDumpSubscription(keyId))!;
    FakeEventSource.instances[0]!.emitTransientBlip();
    expect(sub.error.value).toBeNull();
    scope.stop();
  });

  it('successful (re)snapshot clears a stale error banner', () => {
    const { scope } = setup();
    const keyId = ref('key1');
    const sub = scope.run(() => useDumpSubscription(keyId))!;
    FakeEventSource.instances[0]!.emit('error', JSON.stringify({ message: 'transient' }));
    expect(sub.error.value).toBe('transient');
    FakeEventSource.instances[0]!.emit('snapshot', JSON.stringify({ records: [newest(1)] }));
    expect(sub.error.value).toBeNull();
    scope.stop();
  });

  it('loadOlder appends and dedups', async () => {
    const { scope } = setup();
    const keyId = ref('key1');
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ records: [newest(2), newest(1)] }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ records: [newest(1)] }) });
    const sub = scope.run(() => useDumpSubscription(keyId))!;

    FakeEventSource.instances[0]!.emit('snapshot', JSON.stringify({ records: [newest(5), newest(3)] }));
    await sub.loadOlder();
    expect(sub.records.value.map(r => r.id)).toEqual(['r-005', 'r-003', 'r-002', 'r-001']);
    await sub.loadOlder();
    expect(sub.records.value.map(r => r.id)).toEqual(['r-005', 'r-003', 'r-002', 'r-001']);
    scope.stop();
  });

  it('server-sent error frame closes the EventSource and re-watching the same keyId opens a fresh one', async () => {
    const { scope } = setup();
    const keyId = ref('key1');
    scope.run(() => useDumpSubscription(keyId))!;
    await nextTick();

    const first = FakeEventSource.instances[0]!;
    first.emit('error', JSON.stringify({ message: 'broker exploded' }));
    expect(first.closed).toBe(true);

    // Force-fire the watcher: bounce through '' (which triggers reset() to
    // clear currentKeyId) then back to 'key1'. open() must close any prior
    // socket (no-op here, already closed) and create a fresh EventSource.
    keyId.value = '';
    await nextTick();
    keyId.value = 'key1';
    await nextTick();
    expect(FakeEventSource.instances.length).toBeGreaterThanOrEqual(2);
    const reopened = FakeEventSource.instances[FakeEventSource.instances.length - 1]!;
    expect(reopened.closed).toBe(false);
    scope.stop();
  });

  it('dedup rebuild past DEDUP_REBUILD_THRESHOLD preserves the just-added id', () => {
    const { scope } = setup();
    const keyId = ref('key1');
    const sub = scope.run(() => useDumpSubscription(keyId))!;

    const es = FakeEventSource.instances[0]!;
    // Seed past the 10k threshold so the next appended event triggers rebuild
    // on the same tick the id is prepended. If rebuild ran BEFORE the prepend
    // the just-added id would fall out of `seen` and a duplicate would slip
    // through. Build the snapshot in one shot for speed.
    const seed: DumpMetadata[] = [];
    for (let i = 0; i < 10_001; i++) seed.push(meta(`r-seed-${i.toString().padStart(6, '0')}`));
    es.emit('snapshot', JSON.stringify({ records: seed }));

    const finalId = 'r-tail';
    es.emit('appended', JSON.stringify(meta(finalId)));
    es.emit('appended', JSON.stringify(meta(finalId)));
    const tailMatches = sub.records.value.filter(r => r.id === finalId).length;
    expect(tailMatches).toBe(1);
    scope.stop();
  });
});
