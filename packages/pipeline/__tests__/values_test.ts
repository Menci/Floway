import { inspect } from 'node:util';

import { expect, it } from 'vitest';

import { emptySide, hostFor } from './run-fixture.ts';
import { asEntry, defineFacts, optional, required, secret } from '../src/index.ts';
import type { Deferred, ManagedStream, Secret } from '../src/index.ts';
import { revealSecret } from '../src/transport.ts';

it('deep-freezes in test mode while preserving shared references, skipping nonempty typed arrays, and pruning already-visited subtrees', async () => {
  const bytes = new Uint8Array([5]);
  let ownKeysVisits = 0;
  const proxiedLeaf = new Proxy({ count: 1 }, {
    ownKeys(target) {
      ownKeysVisits += 1;
      return Reflect.ownKeys(target);
    },
  });
  const shared = Object.freeze({ leaf: proxiedLeaf, bytes });
  const marked = secret({ shared });
  const frame = { shared };
  const deferred = { shared };

  type Rq = { marked: Secret<{ shared: typeof shared }>; shared: typeof shared };
  type Rs = {
    shared: typeof shared;
    body: ManagedStream<typeof frame, never>;
    metadata: Deferred<typeof deferred>;
  };
  const space = defineFacts<Rq, Rs>();
  const { host, services } = hostFor({});

  const terminal = space.defineStage({
    name: 'immutable-values',
    request: {
      needs: {
        marked: required<Secret<{ shared: typeof shared }>>(),
        shared: required<typeof shared>(),
      },
    },
    return: {
      provides: {
        shared: required<typeof shared>(),
        body: required<ManagedStream<typeof frame, never>>(),
        metadata: required<Deferred<typeof deferred>>(),
      },
    },
    execute: async (facts, scope) => {
      expect(Object.isFrozen(facts)).toBe(true);
      expect(Object.isFrozen(revealSecret(facts.marked))).toBe(true);
      expect(Object.isFrozen(facts.shared.leaf)).toBe(true);
      expect(facts.shared).toBe(shared);
      expect(facts.shared.bytes).toBe(bytes);
      expect(Object.isFrozen(bytes)).toBe(false);
      // Leaf was frozen once on entry; second visit during Secret traversal was pruned by WeakSet.
      const visitsAfterEntry = ownKeysVisits;
      expect(visitsAfterEntry).toBeGreaterThanOrEqual(1);
      return {
        shared: facts.shared,
        body: scope.createStream(async function* () { yield { ok: true, value: frame }; }),
        metadata: scope.createDeferred(async () => deferred),
      };
    },
  });

  const entry = asEntry(space.compose('freeze', {
    entry: {
      marked: required<Secret<{ shared: typeof shared }>>(),
      shared: required<typeof shared>(),
    },
    exit: {
      shared: required<typeof shared>(),
      body: required<ManagedStream<typeof frame, never>>(),
      metadata: required<Deferred<typeof deferred>>(),
    },
    stages: [],
    ending: terminal,
  }));

  const call = host.run(entry, { marked, shared }, { services });
  const answer = await call;
  expect(answer.shared).toBe(shared);
  expect(Object.isFrozen(answer)).toBe(true);
  const visitsBeforeStreamAndDeferred = ownKeysVisits;

  const cursor = host.read(answer.body);
  const first = await cursor.next();
  expect(first.value).toEqual({ ok: true, value: frame });
  expect(Object.isFrozen(first.value)).toBe(true);
  expect(Object.isFrozen(frame)).toBe(true);
  expect((await cursor.next()).done).toBe(true);
  await expect(host.read(answer.metadata)).resolves.toBe(deferred);
  expect(Object.isFrozen(deferred)).toBe(true);
  // Already-visited `shared` subtree was skipped on response handoff, stream frame, and deferred settlement.
  expect(ownKeysVisits).toBe(visitsBeforeStreamAndDeferred);

  host.abort(call).discard();
  host.close();
});

it('skips deep-freezing in production mode while keeping handle custody checks active', async () => {
  const prevVitest = process.env.VITEST;
  delete process.env.VITEST;
  try {
    type Rq = { payload: { mutable: number } };
    type Rs = {
      payload: { mutable: number };
      body: ManagedStream<{ item: number }, never>;
      meta: Deferred<{ done: number }>;
    };
    const space = defineFacts<Rq, Rs>();
    const { host, services, settle } = hostFor({});
    const payload = { mutable: 1 };
    const frameObj = { item: 2 };
    const deferredObj = { done: 3 };

    const terminal = space.defineStage({
      name: 'prod-stage',
      request: { needs: { payload: required<{ mutable: number }>() } },
      return: {
        provides: {
          payload: required<{ mutable: number }>(),
          body: required<ManagedStream<{ item: number }, never>>(),
          meta: required<Deferred<{ done: number }>>(),
        },
      },
      execute: async (facts, scope) => {
        expect(Object.isFrozen(facts)).toBe(false);
        expect(Object.isFrozen(facts.payload)).toBe(false);
        return {
          payload: facts.payload,
          body: scope.createStream(async function* () { yield { ok: true, value: frameObj }; }),
          meta: scope.createDeferred(async () => deferredObj),
        };
      },
    });

    const entry = asEntry(space.compose('prod', {
      entry: { payload: required<{ mutable: number }>() },
      exit: {
        payload: required<{ mutable: number }>(),
        body: required<ManagedStream<{ item: number }, never>>(),
        meta: required<Deferred<{ done: number }>>(),
      },
      stages: [],
      ending: terminal,
    }));

    const call = host.run(entry, { payload }, { services });
    const answer = await call;
    expect(Object.isFrozen(answer)).toBe(false);
    expect(Object.isFrozen(answer.payload)).toBe(false);

    const cursor = host.read(answer.body);
    expect(() => host.read(answer.body)).toThrow('Cannot open a stream twice');
    const first = await cursor.next();
    expect(first.done).toBe(false);
    expect(Object.isFrozen(first.value)).toBe(false);
    expect(Object.isFrozen(frameObj)).toBe(false);
    expect((await cursor.next()).done).toBe(true);

    const resolvedMeta = await host.read(answer.meta);
    expect(resolvedMeta).toBe(deferredObj);
    expect(Object.isFrozen(deferredObj)).toBe(false);

    expect(() => host.close()).toThrow('HostScope closed with 1 undiscarded run(s)');
    await settle();
  } finally {
    if (prevVitest === undefined) delete process.env.VITEST;
    else process.env.VITEST = prevVitest;
  }
});

it('preserves Secret marking through map and exposes plaintext only through revealSecret', () => {
  const value = secret('private credential');
  const derived = value.map(credential => ({ header: `Bearer ${credential}` }));
  expect(Object.keys(value)).toEqual([]);
  expect(Object.keys(derived)).toEqual([]);
  expect(JSON.stringify(derived)).toBe('"[secret]"');
  expect(String(derived)).toBe('[secret]');
  expect(inspect(derived)).toBe('[secret]');
  expect(revealSecret(derived)).toEqual({ header: 'Bearer private credential' });
  expect(revealSecret(secret(undefined))).toBeUndefined();
  expect(() => revealSecret({} as Secret<string>)).toThrow('Expected a pipeline secret');
});

it('rejects non-plain fact dictionaries, symbol keys, and accessor getters on fact dictionaries', async () => {
  const space = defineFacts<{ value: number }, { value: number }>();
  const entry = asEntry(space.compose('strict-facts', {
    entry: { value: required<number>() },
    exit: { value: required<number>() },
    stages: [],
    ending: space.defineStage({
      name: 'echo',
      request: { needs: { value: required<number>() } },
      return: { provides: { value: required<number>() } },
      execute: async ({ value }) => ({ value }),
    }),
  }));

  const { host, services } = hostFor({});
  class Custom { value = 1; }
  const sym = Symbol('hidden');

  expect(() => host.run(entry, null as never, { services })).toThrow('requires a plain fact dictionary');
  expect(() => host.run(entry, [1] as never, { services })).toThrow('requires a plain fact dictionary');
  expect(() => host.run(entry, new Custom() as never, { services })).toThrow('requires a plain fact dictionary');
  expect(() => host.run(entry, { value: 1, [sym]: 'smuggled' } as never, { services })).toThrow('must not contain symbol keys');
  expect(() => host.run(entry, { get value() { return 1; } } as never, { services })).toThrow('must not contain accessor property "value"');
  host.close();
});

it('discovers handles and freezes nested objects behind own getters, Symbol keys, and mutated Maps', async () => {
  const sym = Symbol('handle-slot');
  type Nested = {
    readonly box: object;
    readonly map: Map<string, Deferred<number>>;
  };
  const space = defineFacts<object, { nested: Nested }>();
  const { host, services, errors, settle } = hostFor({});
  const mutableBehindGetter = { count: 1 };
  const mutableBehindSymbol = { count: 2 };
  const sharedMap = new Map<string, Deferred<number>>();

  // Pre-freeze sharedMap in an earlier run to ensure resourcesIn never skips Maps via frozen cache.
  const warmupSpace = defineFacts<{ map: Map<string, Deferred<number>> }, { ok: true }>();
  const warmupEntry = asEntry(warmupSpace.compose('warmup', {
    entry: { map: required<Map<string, Deferred<number>>>() },
    exit: { ok: required<true>() },
    stages: [],
    ending: warmupSpace.defineStage({
      name: 'warmup',
      request: { needs: { map: required<Map<string, Deferred<number>>>() } },
      return: { provides: { ok: required<true>() } },
      execute: async () => ({ ok: true }),
    }),
  }));
  const warmCall = host.run(warmupEntry, { map: sharedMap }, { services });
  await warmCall;
  host.discard(warmCall);

  const entry = asEntry(space.compose('deep-discovery', {
    entry: {},
    exit: { nested: required<Nested>() },
    stages: [],
    ending: space.defineStage({
      name: 'produce',
      request: { needs: {} },
      return: { provides: { nested: required<Nested>() } },
      execute: async (_f, scope) => {
        const d1 = scope.createDeferred(async () => 10);
        const d2 = scope.createDeferred(async () => 20);
        const d3 = scope.createDeferred(async () => 30);
        sharedMap.set('late-added', d3);
        const box = {
          get hiddenDeferred() { return d1; },
          get hiddenMutable() { return mutableBehindGetter; },
          [sym]: { d2, mutableBehindSymbol },
        };
        return { nested: { box, map: sharedMap } };
      },
    }),
  }));

  const call = host.run(entry, {}, { services });
  const answer = await call;
  expect(Object.isFrozen(mutableBehindGetter)).toBe(true);
  expect(Object.isFrozen(mutableBehindSymbol)).toBe(true);

  const box = answer.nested.box as { hiddenDeferred: Deferred<number>; [sym]: { d2: Deferred<number> } };
  await expect(host.read(box.hiddenDeferred)).resolves.toBe(10);
  await expect(host.read(box[sym].d2)).resolves.toBe(20);
  await expect(host.read(answer.nested.map.get('late-added')!)).resolves.toBe(30);
  host.discard(call);
  host.close();
  await settle();
  expect(errors).toEqual([]);
});

it('preserves original deferred rejection on read() and rejects invalid stream/deferred factory return values without leaking handles', async () => {
  const space = defineFacts<{ mode: 'reject-deferred' | 'bad-deferred' | 'bad-stream' | 'settled-leak' }, {
    deferred: Deferred<number>;
    ok: true;
  }>();
  const originalRejection = new Error('deferred boom');

  const entry = asEntry(space.compose('resource-edges', {
    entry: { mode: required<'reject-deferred' | 'bad-deferred' | 'bad-stream' | 'settled-leak'>() },
    exit: { deferred: optional<Deferred<number>>(), ok: optional<true>() },
    stages: [],
    ending: space.defineStage({
      name: 'edge',
      request: { needs: { mode: required<'reject-deferred' | 'bad-deferred' | 'bad-stream' | 'settled-leak'>() } },
      return: { provides: { deferred: optional<Deferred<number>>(), ok: optional<true>() } },
      execute: async ({ mode }, scope) => {
        if (mode === 'reject-deferred') {
          const d = scope.createDeferred(async () => { throw originalRejection; });
          // Let rejection settle BEFORE transferring to host.
          await Promise.resolve();
          await Promise.resolve();
          return { deferred: d };
        }
        if (mode === 'bad-deferred') {
          scope.createDeferred(() => 'not-a-promise' as unknown as Promise<number>);
          return { ok: true };
        }
        if (mode === 'bad-stream') {
          scope.createStream(() => 'not-a-generator' as never);
          return { ok: true };
        }
        const completed = Promise.resolve({ value: 1 });
        scope.createDeferred(() => completed);
        const value = await completed;
        expect(Object.isFrozen(value)).toBe(true);
        return { ok: true };
      },
    }),
  }));

  const { host, services, errors, settle } = hostFor({});

  const rejCall = host.run(entry, { mode: 'reject-deferred' }, { services });
  const rejAnswer = await rejCall;
  await expect(host.read(rejAnswer.deferred!)).rejects.toBe(originalRejection);
  host.discard(rejCall);

  await expect(host.run(entry, { mode: 'bad-deferred' }, { services })).rejects.toThrow('must return a Promise');
  await expect(host.run(entry, { mode: 'bad-stream' }, { services })).rejects.toThrow('must return an AsyncGenerator');
  await expect(host.run(entry, { mode: 'settled-leak' }, { services })).rejects.toThrow('leaked 1 stream or deferred handle');

  host.close();
  await settle();
  expect(errors).toEqual([]);
});

it.each([false, true])('rejects a producer leak or an expired execute scope (expired=%s)', async expired => {
  type Rs = { body: ManagedStream<string, never> };
  const space = defineFacts<object, Rs>();
  const { host, services, errors, settle } = hostFor({});
  const visited: string[] = [];

  const source = space.defineStage({
    name: 'source',
    request: { needs: {} },
    return: { provides: { body: required<ManagedStream<string, never>>() } },
    execute: async (_facts, scope) => ({
      body: scope.createStream(async function* () {
        try {
          yield { ok: true, value: 'orphaned upstream' };
        } finally {
          visited.push('source finally');
        }
      }),
    }),
  });

  const wrapper = space.defineStage({
    name: 'wrapper',
    through: {
      request: emptySide,
      response: {
        needs: { body: required<ManagedStream<string, never>>() },
        provides: { body: required<ManagedStream<string, never>>() },
        consumes: [],
      },
    },
    execute: async (facts, scope) => {
      const back = await scope.next(facts);
      const body = scope.wrapStream(back.body, async function* () {
        if (expired) {
          await scope.next(facts);
        }
        yield { ok: true, value: 'wrapper' } as const;
      });
      return { ...back, body };
    },
  });

  const entry = asEntry(space.compose('holder-boundary', {
    entry: {},
    exit: { body: required<ManagedStream<string, never>>() },
    stages: [wrapper],
    ending: source,
  }));

  const call = host.run(entry, {}, { services });
  const answer = await call;
  const cursor = host.read(answer.body);
  if (expired) {
    await expect(cursor.next()).rejects.toThrow('scope has exited');
  } else {
    await expect(cursor.next()).resolves.toEqual({ done: false, value: { ok: true, value: 'wrapper' } });
    await expect(cursor.next()).rejects.toThrow('leaked 1 stream or deferred handle');
  }
  host.discard(call);
  host.close();
  await settle();
  expect(visited).toEqual(['source finally']);
  expect(errors).toEqual([]);
});

it.each([
  ['in-place', 'returned undeclared "invented"'],
  ['single', 'removed or changed undeclared "hidden"'],
] as const)('checks non-enumerable own keys on %s handoffs', async (path, failure) => {
  const space = defineFacts<object, { value: string; hidden: string }>();
  const { host, services } = hostFor({});

  const terminal = space.defineStage({
    name: 'terminal',
    request: { needs: {} },
    return: { provides: { value: required<string>(), hidden: optional<string>() } },
    execute: async () => Object.defineProperty({ value: 'answer' }, path === 'in-place' ? 'invented' : 'hidden', { value: 'source' }),
  });

  const stage = space.defineStage({
    name: 'handoff',
    through: {
      request: emptySide,
      response: { needs: { value: required<string>() }, provides: {}, consumes: [] },
    },
    execute: async (facts, scope) => {
      const back = await scope.next({ ...facts });
      return Object.defineProperty({ ...back }, 'hidden', { value: 'changed' });
    },
  });

  const entry = asEntry(space.compose('non-enum', {
    entry: {},
    exit: { value: required<string>(), hidden: optional<string>() },
    stages: [stage],
    ending: terminal,
  }));

  await expect(host.run(entry, {}, { services })).rejects.toThrow(failure);
  host.close();
});
