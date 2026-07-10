import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';

import { useAgentSetup } from './useAgentSetup.ts';
import type { ApiClient } from '../api/client.ts';

// --- fake RPC client -------------------------------------------------------
//
// callApi() only touches `response.ok`, `response.status`, and `response.json()`,
// so a fake client returns plain objects with that surface. Each method records
// its calls and hands back a deferred the test resolves by hand, which lets the
// fake-timer tests drive one in-flight request at a time.

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

interface FakeResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

const okBody = (body: unknown): FakeResponse => ({ ok: true, status: 200, json: async () => body });
const errorBody = (status: number, body: unknown = { error: `HTTP ${status}` }): FakeResponse => ({
  ok: false,
  status,
  json: async () => body,
});
const conflictBody = (body: unknown): FakeResponse => errorBody(409, body);

interface RecordedCall {
  args: unknown[];
  deferred: Deferred<FakeResponse>;
}

const makeApi = () => {
  const records: Record<'post' | 'put' | 'heartbeat', RecordedCall[]> = { post: [], put: [], heartbeat: [] };
  const method = (name: 'post' | 'put' | 'heartbeat') => vi.fn((...args: unknown[]) => {
    const d = deferred<FakeResponse>();
    records[name].push({ args, deferred: d });
    return d.promise;
  });
  const api = { api: { setup: { $post: method('post'), $put: method('put'), heartbeat: { $post: method('heartbeat') } } } };
  return { api: api as unknown as ApiClient, records };
};

const defaultConfig = () => ({
  apiKeyId: 'key-1',
  claudeCode: {
    enabled: true, model: null, defaultSonnetModel: null, defaultHaikuModel: null, effortLevel: null, modelDiscovery: true,
  },
  codex: { enabled: true, model: null, reasoningEffort: null },
});

const lease = (over: Record<string, unknown> = {}) => ({
  status: 'ok',
  token: 'tok-1',
  configuration: defaultConfig(),
  configurationRevision: 1,
  expiresAt: Date.now() + 5 * 60 * 1000,
  scripts: { sh: '/api/setup/tok-1/setup.sh', ps1: '/api/setup/tok-1/setup.ps1' },
  ...over,
});

const jsonArg = (call: RecordedCall): Record<string, unknown> =>
  (call.args[0] as { json: Record<string, unknown> }).json;

const signalArg = (call: RecordedCall): AbortSignal =>
  (call.args[1] as { init: { signal: AbortSignal } }).init.signal;

let scope: ReturnType<typeof effectScope> | null = null;

const run = <T>(fn: () => T): T => {
  scope = effectScope();
  return scope.run(fn)!;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  scope?.stop();
  scope = null;
  vi.useRealTimers();
});

describe('useAgentSetup — lease acquisition', () => {
  it('posts exactly one create with the window origin and adopts the returned lease', async () => {
    const { api, records } = makeApi();
    const setup = run(() => useAgentSetup(api));

    expect(records.post.length).toBe(1);
    expect(jsonArg(records.post[0]!)).toEqual({ publicBaseUrl: window.location.origin });
    expect(setup.state.initialized.value).toBe(false);

    records.post[0]!.deferred.resolve(okBody(lease()));
    await vi.advanceTimersByTimeAsync(0);

    expect(setup.state.initialized.value).toBe(true);
    expect(setup.state.token.value).toBe('tok-1');
    expect(setup.state.configurationRevision.value).toBe(1);
    expect(setup.state.scripts.value).toEqual({ sh: '/api/setup/tok-1/setup.sh', ps1: '/api/setup/tok-1/setup.ps1' });
    expect(setup.draft.value).toEqual(defaultConfig());
    // Only the one create — no duplicate POST.
    expect(records.post.length).toBe(1);
  });

  it('restores a persisted draft the server hands back on reopen', async () => {
    const { api, records } = makeApi();
    const restored = { ...defaultConfig(), codex: { enabled: false, model: 'gpt-5-codex', reasoningEffort: 'high' } };
    const setup = run(() => useAgentSetup(api));
    records.post[0]!.deferred.resolve(okBody(lease({ configuration: restored, configurationRevision: 4 })));
    await vi.advanceTimersByTimeAsync(0);

    expect(setup.draft.value).toEqual(restored);
    expect(setup.state.configurationRevision.value).toBe(4);
  });

  it('surfaces the no-selectable-key sentinel from a 409 create body', async () => {
    const { api, records } = makeApi();
    const setup = run(() => useAgentSetup(api));
    records.post[0]!.deferred.resolve(conflictBody({ status: 'no-selectable-key' }));
    await vi.advanceTimersByTimeAsync(0);

    expect(setup.state.noSelectableKey.value).toBe(true);
    expect(setup.state.initialized.value).toBe(false);
    expect(setup.canCopy.value).toBe(false);
  });
});

// Drive an initialized instance to the point where a lease is live and clean.
const startInitialized = async (over: Record<string, unknown> = {}, keys?: readonly string[]) => {
  const { api, records } = makeApi();
  const setup = run(() => useAgentSetup(api, keys ?? ['key-1']));
  records.post[0]!.deferred.resolve(okBody(lease(over)));
  await vi.advanceTimersByTimeAsync(0);
  return { api, records, setup };
};

describe('useAgentSetup — debounced serialized saves', () => {
  it('debounces edits by 400ms before issuing a PUT', async () => {
    const { records, setup } = await startInitialized();

    setup.draft.value!.claudeCode.model = 'claude-sonnet-4-5[1m]';
    setup.save();
    expect(setup.syncing.value).toBe(true);
    expect(setup.canCopy.value).toBe(false);

    await vi.advanceTimersByTimeAsync(399);
    expect(records.put.length).toBe(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(records.put.length).toBe(1);
    expect(jsonArg(records.put[0]!)).toEqual({
      token: 'tok-1',
      configuration: { ...defaultConfig(), claudeCode: { ...defaultConfig().claudeCode, model: 'claude-sonnet-4-5[1m]' } },
      expectedRevision: 1,
    });
  });

  it('coalesces rapid edits within the debounce window into a single PUT', async () => {
    const { records, setup } = await startInitialized();
    setup.draft.value!.codex.reasoningEffort = 'low';
    setup.save();
    await vi.advanceTimersByTimeAsync(200);
    setup.draft.value!.codex.reasoningEffort = 'high';
    setup.save();
    await vi.advanceTimersByTimeAsync(400);

    expect(records.put.length).toBe(1);
    expect(jsonArg(records.put[0]!).configuration).toMatchObject({ codex: { reasoningEffort: 'high' } });
  });

  it('keeps a second edit queued behind the in-flight save and resubmits with the new revision', async () => {
    const { records, setup } = await startInitialized();

    setup.draft.value!.codex.model = 'gpt-5-codex';
    setup.save();
    await vi.advanceTimersByTimeAsync(400);
    expect(records.put.length).toBe(1);

    // Edit again while PUT #1 is still in flight.
    setup.draft.value!.codex.reasoningEffort = 'high';
    setup.save();
    await vi.advanceTimersByTimeAsync(400);
    // Still only one PUT — the pump serializes, PUT #1 has not resolved.
    expect(records.put.length).toBe(1);

    records.put[0]!.deferred.resolve(okBody(lease({ configurationRevision: 2 })));
    await vi.advanceTimersByTimeAsync(400);

    expect(records.put.length).toBe(2);
    expect(jsonArg(records.put[1]!)).toMatchObject({ expectedRevision: 2 });
    expect(jsonArg(records.put[1]!).configuration).toMatchObject({
      codex: { model: 'gpt-5-codex', reasoningEffort: 'high' },
    });
  });

  it('direct form mutation immediately gates copy, queues a save, and re-enables copy only after confirmation', async () => {
    const { records, setup } = await startInitialized();
    expect(setup.canCopy.value).toBe(true);

    // Task 6 may bind controls directly to nested draft fields. The deep watcher
    // owns dirtying and autosave; callers do not need to remember save().
    setup.draft.value!.claudeCode.effortLevel = 'high';
    expect(setup.syncing.value).toBe(true);
    expect(setup.canCopy.value).toBe(false);

    await vi.advanceTimersByTimeAsync(399);
    expect(records.put.length).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(records.put.length).toBe(1);

    records.put[0]!.deferred.resolve(okBody(lease({ configurationRevision: 2 })));
    await vi.advanceTimersByTimeAsync(0);
    expect(setup.syncing.value).toBe(false);
    expect(setup.canCopy.value).toBe(true);
    expect(setup.state.configurationRevision.value).toBe(2);
  });

  it('a stale save response updates lease metadata without clearing a newer draft', async () => {
    const { records, setup } = await startInitialized();
    setup.draft.value!.codex.model = 'gpt-5-codex';
    setup.save();
    await vi.advanceTimersByTimeAsync(400);

    // A newer edit lands while PUT #1 is in flight.
    setup.draft.value!.codex.reasoningEffort = 'high';
    setup.save();

    records.put[0]!.deferred.resolve(okBody(lease({ token: 'tok-2', configurationRevision: 2 })));
    await vi.advanceTimersByTimeAsync(0);

    // Metadata advanced, but the draft still carries the newer edit and stays dirty.
    expect(setup.state.token.value).toBe('tok-2');
    expect(setup.state.configurationRevision.value).toBe(2);
    expect(setup.draft.value!.codex.reasoningEffort).toBe('high');
    expect(setup.syncing.value).toBe(true);
  });
});

describe('useAgentSetup — revision conflict', () => {
  it('adopts server state when no newer local edit exists', async () => {
    const { records, setup } = await startInitialized();
    setup.draft.value!.codex.model = 'gpt-5-codex';
    setup.save();
    await vi.advanceTimersByTimeAsync(400);

    const serverConfig = { ...defaultConfig(), claudeCode: { ...defaultConfig().claudeCode, model: 'claude-opus-4-8' } };
    records.put[0]!.deferred.resolve(conflictBody(lease({
      status: 'revision-conflict', configuration: serverConfig, configurationRevision: 7, token: 'tok-9',
    })));
    await vi.advanceTimersByTimeAsync(0);

    expect(setup.draft.value).toEqual(serverConfig);
    expect(setup.state.configurationRevision.value).toBe(7);
    expect(setup.state.token.value).toBe('tok-9');
    expect(setup.syncing.value).toBe(false);
    expect(records.put.length).toBe(1);
  });

  it('resubmits the latest draft when a newer local edit exists', async () => {
    const { records, setup } = await startInitialized();
    setup.draft.value!.codex.model = 'gpt-5-codex';
    setup.save();
    await vi.advanceTimersByTimeAsync(400);

    // Newer edit while PUT #1 is in flight.
    setup.draft.value!.codex.reasoningEffort = 'medium';
    setup.save();

    records.put[0]!.deferred.resolve(conflictBody(lease({
      status: 'revision-conflict', configuration: defaultConfig(), configurationRevision: 5,
    })));
    await vi.advanceTimersByTimeAsync(400);

    expect(records.put.length).toBe(2);
    expect(jsonArg(records.put[1]!)).toMatchObject({ expectedRevision: 5 });
    expect(jsonArg(records.put[1]!).configuration).toMatchObject({
      codex: { model: 'gpt-5-codex', reasoningEffort: 'medium' },
    });

    records.put[1]!.deferred.resolve(okBody(lease({ configurationRevision: 6 })));
    await vi.advanceTimersByTimeAsync(0);
    // Advancing past the newer edit's original debounce must not emit PUT #3.
    await vi.advanceTimersByTimeAsync(400);
    expect(records.put.length).toBe(2);
  });
});

describe('useAgentSetup — heartbeat', () => {
  it('renews the lease every 60 seconds while visible', async () => {
    const { records } = await startInitialized();
    expect(records.heartbeat.length).toBe(0);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(records.heartbeat.length).toBe(1);
    expect(jsonArg(records.heartbeat[0]!)).toEqual({ token: 'tok-1' });

    records.heartbeat[0]!.deferred.resolve(okBody(lease({ expiresAt: Date.now() + 5 * 60 * 1000 })));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(records.heartbeat.length).toBe(2);
  });

  it('adopts a rotated token and script URLs when the heartbeat renews an expired lease', async () => {
    const { records, setup } = await startInitialized();
    await vi.advanceTimersByTimeAsync(60_000);

    records.heartbeat[0]!.deferred.resolve(okBody(lease({
      token: 'tok-rotated',
      scripts: { sh: '/api/setup/tok-rotated/setup.sh', ps1: '/api/setup/tok-rotated/setup.ps1' },
      expiresAt: Date.now() + 5 * 60 * 1000,
    })));
    await vi.advanceTimersByTimeAsync(0);

    expect(setup.state.token.value).toBe('tok-rotated');
    expect(setup.state.scripts.value!.sh).toBe('/api/setup/tok-rotated/setup.sh');
    expect(setup.canCopy.value).toBe(true);
  });

  it('does not overlap a heartbeat with an in-flight save', async () => {
    const { records, setup } = await startInitialized();
    setup.draft.value!.codex.model = 'gpt-5-codex';
    setup.save();
    await vi.advanceTimersByTimeAsync(400);
    expect(records.put.length).toBe(1);

    // Request a heartbeat while the PUT is still in flight (inside the request
    // timeout). The pump must hold it behind the save.
    setup.heartbeat();
    await vi.advanceTimersByTimeAsync(0);
    expect(records.heartbeat.length).toBe(0);

    records.put[0]!.deferred.resolve(okBody(lease({ configurationRevision: 2 })));
    await vi.advanceTimersByTimeAsync(0);
    // The queued heartbeat runs only after the save clears.
    expect(records.heartbeat.length).toBe(1);
  });

  it('aborts a hung heartbeat after 20s and retries 15s later', async () => {
    const { records } = await startInitialized();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(records.heartbeat.length).toBe(1);

    // Never resolve it: the 20s request timeout aborts, the 15s backoff re-arms.
    await vi.advanceTimersByTimeAsync(20_000);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(records.heartbeat.length).toBe(2);
  });

  it('retries a save whose transport failed', async () => {
    const { records, setup } = await startInitialized();
    setup.draft.value!.codex.model = 'gpt-5-codex';
    await vi.advanceTimersByTimeAsync(400);
    expect(records.put.length).toBe(1);

    records.put[0]!.deferred.reject(new Error('network down'));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(records.put.length).toBe(2);
    expect(jsonArg(records.put[1]!).configuration).toMatchObject({ codex: { model: 'gpt-5-codex' } });
  });

  it('retries explicit retryable HTTP statuses for saves and heartbeats', async () => {
    const { records, setup } = await startInitialized();
    setup.draft.value!.codex.model = 'gpt-5-codex';
    await vi.advanceTimersByTimeAsync(400);
    records.put[0]!.deferred.resolve(errorBody(429));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(records.put.length).toBe(2);

    // Complete the retry so the serialized pump can service heartbeat.
    records.put[1]!.deferred.resolve(okBody(lease({ configurationRevision: 2 })));
    await vi.advanceTimersByTimeAsync(0);
    setup.heartbeat();
    await vi.advanceTimersByTimeAsync(0);
    records.heartbeat[0]!.deferred.resolve(errorBody(503));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(records.heartbeat.length).toBe(2);
  });

  it('does not retry permanent 4xx save or heartbeat failures', async () => {
    const { records, setup } = await startInitialized();
    setup.draft.value!.codex.model = 'gpt-5-codex';
    await vi.advanceTimersByTimeAsync(400);
    records.put[0]!.deferred.resolve(errorBody(400, { error: 'bad configuration' }));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(records.put.length).toBe(1);
    expect(setup.state.error.value).toBe('bad configuration');

    // A manual heartbeat may still be attempted, but its permanent 403 must not
    // schedule the 15s retry (the regular 60s lease cadence remains independent).
    setup.heartbeat();
    await vi.advanceTimersByTimeAsync(0);
    records.heartbeat[0]!.deferred.resolve(errorBody(403, { error: 'forbidden' }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(records.heartbeat.length).toBe(1);
    expect(setup.state.error.value).toBe('forbidden');
  });
});

describe('useAgentSetup — terminal + lifecycle', () => {
  it('marks the instance superseded and stops scheduling on a superseded response', async () => {
    const { records, setup } = await startInitialized();
    setup.draft.value!.codex.model = 'gpt-5-codex';
    setup.save();
    await vi.advanceTimersByTimeAsync(400);

    records.put[0]!.deferred.resolve(conflictBody({ status: 'superseded' }));
    await vi.advanceTimersByTimeAsync(0);

    expect(setup.superseded.value).toBe(true);
    expect(setup.canCopy.value).toBe(false);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(records.heartbeat.length).toBe(0);
    expect(records.put.length).toBe(1);
  });

  it('dispose() aborts an active save, clears every timer, and ignores late responses', async () => {
    const { records, setup } = await startInitialized();
    setup.draft.value!.codex.model = 'gpt-5-codex';
    await vi.advanceTimersByTimeAsync(400);
    const signal = signalArg(records.put[0]!);
    expect(signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    setup.dispose();
    expect(signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    records.put[0]!.deferred.resolve(okBody(lease({ token: 'tok-late', configurationRevision: 9 })));
    await vi.advanceTimersByTimeAsync(0);

    expect(records.heartbeat.length).toBe(0);
    expect(setup.state.token.value).toBe('tok-1');
  });

  it.each(['create', 'heartbeat'] as const)('dispose() aborts an active %s request', async kind => {
    const { api, records } = makeApi();
    const setup = run(() => useAgentSetup(api));
    let call = records.post[0]!;

    if (kind === 'heartbeat') {
      call.deferred.resolve(okBody(lease()));
      await vi.advanceTimersByTimeAsync(0);
      setup.heartbeat();
      await vi.advanceTimersByTimeAsync(0);
      call = records.heartbeat[0]!;
    }

    const signal = signalArg(call);
    expect(signal.aborted).toBe(false);
    setup.dispose();
    expect(signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gates copy on the selected key still existing and saves a direct key change', async () => {
    const { records, setup } = await startInitialized({}, ['key-2']);
    // draft.apiKeyId is 'key-1' but the account only offers 'key-2'.
    expect(setup.canCopy.value).toBe(false);

    setup.draft.value!.apiKeyId = 'key-2';
    // The selected key now exists, but the direct mutation is dirty until saved.
    expect(setup.canCopy.value).toBe(false);
    await vi.advanceTimersByTimeAsync(400);
    expect(records.put.length).toBe(1);
    records.put[0]!.deferred.resolve(okBody(lease({
      configuration: { ...defaultConfig(), apiKeyId: 'key-2' },
      configurationRevision: 2,
    })));
    await vi.advanceTimersByTimeAsync(0);
    expect(setup.canCopy.value).toBe(true);
  });
});

describe('useAgentSetup — visibility', () => {
  const setVisibility = (state: 'visible' | 'hidden') => {
    Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  };

  afterEach(() => setVisibility('visible'));

  it('pauses heartbeat scheduling while hidden and reconciles immediately on resume', async () => {
    const { records } = await startInitialized();

    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(records.heartbeat.length).toBe(0);

    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(0);
    expect(records.heartbeat.length).toBe(1);
    records.heartbeat[0]!.deferred.resolve(okBody(lease()));
    await vi.advanceTimersByTimeAsync(0);
  });

  it('resume flushes a hidden dirty draft once without leaving its debounce to duplicate the PUT', async () => {
    const { records, setup } = await startInitialized();
    setVisibility('hidden');
    setup.draft.value!.codex.model = 'gpt-5-codex';
    expect(setup.canCopy.value).toBe(false);

    // Resume before the 400ms debounce fires: the immediate reconciliation must
    // cancel that timer and serialize save before heartbeat.
    await vi.advanceTimersByTimeAsync(100);
    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(0);
    expect(records.put.length).toBe(1);
    expect(records.heartbeat.length).toBe(0);

    records.put[0]!.deferred.resolve(okBody(lease({ configurationRevision: 2 })));
    await vi.advanceTimersByTimeAsync(0);
    expect(records.heartbeat.length).toBe(1);
    records.heartbeat[0]!.deferred.resolve(okBody(lease({ configurationRevision: 2 })));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(400);
    expect(records.put.length).toBe(1);
  });
});
