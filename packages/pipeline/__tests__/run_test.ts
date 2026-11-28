import { expect, it } from 'vitest';

import { createResponseCanary, emptySide, hostFor } from './run-fixture.ts';
import { asEntry, createHostScope, defineFacts, optional, required } from '../src/index.ts';
import type { Deferred, ManagedStream, Result } from '../src/index.ts';

it('failover calls scope.abort(call).discard() on a losing answer including undeclared handles before retrying', async () => {
  type Rq = { candidate: number };
  type Rs = {
    outcome: 'retry' | 'selected';
    source: ManagedStream<string, string>;
    metadata: { usage: Deferred<number> };
  };
  const space = defineFacts<Rq, Rs>();
  const { host, services, background, errors, settle } = hostFor({});
  const attempts: number[] = [];
  const stopped: boolean[] = [];
  const deferred = Promise.withResolvers<number>();

  const attempt = space.defineStage({
    name: 'attempt',
    request: { needs: { candidate: required<number>() } },
    return: {
      provides: {
        outcome: required<'retry' | 'selected'>(),
        source: optional<ManagedStream<string, string>>(),
        metadata: optional<{ usage: Deferred<number> }>(),
      },
    },
    execute: async ({ candidate }, scope) => {
      attempts.push(candidate);
      if (candidate === 2) return { outcome: 'selected' };
      return {
        outcome: 'retry',
        source: scope.createStream(async function* (producer) {
          stopped.push(producer.signal.aborted);
          yield { ok: false, error: 'aborted' };
        }),
        metadata: { usage: scope.createDeferred(() => deferred.promise) },
      };
    },
  });

  const failover = space.defineStage({
    name: 'failover',
    through: {
      request: { needs: { candidate: required<number>() }, provides: { candidate: required<number>() }, consumes: [] },
      response: { needs: { outcome: required<'retry' | 'selected'>() }, provides: {}, consumes: [] },
    },
    execute: async (facts, scope) => {
      const firstCall = scope.next(facts);
      const losing = await firstCall;
      expect(losing.outcome).toBe('retry');
      scope.abort(firstCall).discard();
      return await scope.next({ ...facts, candidate: 2 });
    },
  });

  const entry = asEntry(space.compose('failover', {
    entry: { candidate: required<number>() },
    exit: {
      outcome: required<'retry' | 'selected'>(),
      source: optional<ManagedStream<string, string>>(),
      metadata: optional<{ usage: Deferred<number> }>(),
    },
    stages: [failover],
    ending: attempt,
  }));

  const call = host.run(entry, { candidate: 1 }, { services });
  const answer = await call;
  expect(answer).toEqual({ outcome: 'selected' });
  expect(attempts).toEqual([1, 2]);
  expect(background).toHaveLength(2);
  host.abort(call).discard();
  host.close();
  deferred.resolve(7);
  await settle();
  expect(stopped).toEqual([true]);
  expect(errors).toEqual([]);
});

it.each(['ok-discard', 'err-auto-drain', 'panic'] as const)(
  'collector produces a scalar via cursor.discard() or Err auto-drain and propagates live read panic (%s)',
  async mode => {
    type Rs = { body: ManagedStream<string, string>; scalar: string };
    const space = defineFacts<object, Rs>();
    const failure = new Error('source read panic');
    const drain = Promise.withResolvers<void>();
    const draining = Promise.withResolvers<void>();
    const { host, services, background, errors, settle } = hostFor({});

    const source = space.defineStage({
      name: 'source',
      request: { needs: {} },
      return: { provides: { body: required<ManagedStream<string, string>>() } },
      execute: async (_facts, scope) => ({
        body: scope.createStream(async function* () {
          if (mode === 'panic') throw failure;
          if (mode === 'err-auto-drain') {
            yield { ok: false, error: 'upstream-error' };
            draining.resolve();
            await drain.promise;
            return;
          }
          yield { ok: true, value: 'first' };
          draining.resolve();
          await drain.promise;
          yield { ok: true, value: 'discarded' };
        }),
      }),
    });

    const collector = space.defineStage({
      name: 'collector',
      through: {
        request: emptySide,
        response: {
          needs: { body: required<ManagedStream<string, string>>() },
          provides: { scalar: required<string>() },
          consumes: ['body'],
        },
      },
      execute: async (facts, scope) => {
        const answer = await scope.next(facts);
        const { body, ...rest } = answer;
        const cursor = scope.read(body);
        const head = await cursor.next();
        if (head.done) throw new Error('Expected at least one frame');
        if (!head.value.ok) {
          return { ...rest, scalar: `err:${head.value.error}` };
        }
        cursor.discard();
        return { ...rest, scalar: head.value.value };
      },
    });

    const entry = asEntry(space.compose('collect', {
      entry: {},
      exit: { scalar: required<string>() },
      stages: [collector],
      ending: source,
    }));

    const call = host.run(entry, {}, { services });
    if (mode === 'panic') {
      await expect(call).rejects.toBe(failure);
      host.close();
      expect(background).toHaveLength(0);
    } else {
      const answer = await call;
      expect(answer).toEqual({ scalar: mode === 'err-auto-drain' ? 'err:upstream-error' : 'first' });
      await draining.promise;
      host.abort(call).discard();
      host.close();
      drain.resolve();
      await settle();
    }
    expect(errors).toEqual([]);
  },
);

it.each([false, true])('hosted tools calls producer.next() for ReAct rounds and discards each call (panic=%s)', async panics => {
  type Rq = { round: number };
  type Rs = { events: ManagedStream<number, never> };
  const space = defineFacts<Rq, Rs>();
  const rounds: number[] = [];
  const failure = new Error('second-round execute panic');
  const { host, services, errors, settle } = hostFor({});

  const terminal = space.defineStage({
    name: 'model',
    request: { needs: { round: required<number>() } },
    return: { provides: { events: required<ManagedStream<number, never>>() } },
    execute: async ({ round }, scope) => {
      rounds.push(round);
      if (panics && round === 2) throw failure;
      return { events: scope.createStream(async function* () { yield { ok: true, value: round }; }) };
    },
  });

  const tools = space.defineStage({
    name: 'hosted-tools',
    through: {
      request: { needs: { round: required<number>() }, provides: { round: required<number>() }, consumes: [] },
      response: {
        needs: { events: required<ManagedStream<number, never>>() },
        provides: { events: required<ManagedStream<number, never>>() },
        consumes: [],
      },
    },
    execute: async (facts, scope) => {
      const first = await scope.next(facts);
      return {
        ...first,
        events: scope.wrapStream(first.events, async function* (source, producer) {
          yield* producer.read(source);
          for (const round of [2, 3]) {
            const roundCall = producer.next({ ...facts, round });
            const further = await roundCall;
            yield* producer.read(further.events);
            producer.discard(roundCall);
          }
        }),
      };
    },
  });

  const entry = asEntry(space.compose('chat', {
    entry: { round: required<number>() },
    exit: { events: required<ManagedStream<number, never>>() },
    stages: [tools],
    ending: terminal,
  }));

  const call = host.run(entry, { round: 1 }, { services });
  const answer = await call;
  const cursor = host.read(answer.events);
  await expect(cursor.next()).resolves.toEqual({ done: false, value: { ok: true, value: 1 } });
  if (panics) {
    await expect(cursor.next()).rejects.toBe(failure);
    expect(rounds).toEqual([1, 2]);
  } else {
    const events: Result<number, never>[] = [];
    for await (const event of cursor) events.push(event);
    expect(events).toEqual([{ ok: true, value: 2 }, { ok: true, value: 3 }]);
    expect(rounds).toEqual([1, 2, 3]);
  }
  host.abort(call).discard();
  host.close();
  await settle();
  expect(errors).toEqual([]);
});

it.each(['stream', 'deferred'] as const)(
  'exiting a %s producer normally with an undiscarded settled producer.next() call triggers a leak panic',
  async kind => {
    type Rq = { round: number };
    type Rs = {
      value: number;
      stream: ManagedStream<number, never>;
      deferred: Deferred<number>;
    };
    const space = defineFacts<Rq, Rs>();
    const { host, services, errors, settle } = hostFor({});

    const terminal = space.defineStage({
      name: 'model',
      request: { needs: { round: required<number>() } },
      return: { provides: { value: required<number>() } },
      execute: async ({ round }) => ({ value: round }),
    });

    const leakyProducer = space.defineStage({
      name: 'leaky-producer',
      through: {
        request: { needs: { round: required<number>() }, provides: { round: required<number>() }, consumes: [] },
        response: {
          needs: { value: required<number>() },
          provides: {
            stream: optional<ManagedStream<number, never>>(),
            deferred: optional<Deferred<number>>(),
          },
          consumes: [],
        },
      },
      execute: async (facts, scope) => {
        const first = await scope.next(facts);
        if (kind === 'stream') {
          return {
            ...first,
            stream: scope.createStream(async function* (producer) {
              const extra = await producer.next({ ...facts, round: 2 });
              yield { ok: true, value: extra.value };
            }),
          };
        }
        return {
          ...first,
          deferred: scope.createDeferred(async producer => {
            const extra = await producer.next({ ...facts, round: 2 });
            return extra.value;
          }),
        };
      },
    });

    const entry = asEntry(space.compose('producer-leak', {
      entry: { round: required<number>() },
      exit: {
        value: required<number>(),
        stream: optional<ManagedStream<number, never>>(),
        deferred: optional<Deferred<number>>(),
      },
      stages: [leakyProducer],
      ending: terminal,
    }));

    const call = host.run(entry, { round: 1 }, { services });
    const answer = await call;
    if (kind === 'stream') {
      const cursor = host.read(answer.stream!);
      await expect(cursor.next()).resolves.toEqual({ done: false, value: { ok: true, value: 2 } });
      await expect(cursor.next()).rejects.toThrow('producer exited with 1 undiscarded child call');
    } else {
      await expect(host.read(answer.deferred!)).rejects.toThrow('producer exited with 1 undiscarded child call');
    }
    host.abort(call).discard();
    host.close();
    await settle();
    expect(errors).toEqual([]);
  },
);

it('supports long multi-round ReAct streams with discarded producer calls cleanly', async () => {
  type Rq = { round: number };
  type Rs = { events: ManagedStream<number, never> };
  const space = defineFacts<Rq, Rs>();
  const { host, services, errors, settle } = hostFor({});
  const totalRounds = 300;

  const terminal = space.defineStage({
    name: 'round-model',
    request: { needs: { round: required<number>() } },
    return: { provides: { events: required<ManagedStream<number, never>>() } },
    execute: async ({ round }, scope) => ({
      events: scope.createStream(async function* () { yield { ok: true, value: round }; }),
    }),
  });

  const loop = space.defineStage({
    name: 'react-loop',
    through: {
      request: { needs: { round: required<number>() }, provides: { round: required<number>() }, consumes: [] },
      response: {
        needs: { events: required<ManagedStream<number, never>>() },
        provides: { events: required<ManagedStream<number, never>>() },
        consumes: [],
      },
    },
    execute: async (facts, scope) => {
      const first = await scope.next(facts);
      return {
        ...first,
        events: scope.wrapStream(first.events, async function* (source, producer) {
          yield* producer.read(source);
          for (let round = 2; round <= totalRounds; round += 1) {
            const roundCall = producer.next({ ...facts, round });
            const roundAnswer = await roundCall;
            yield* producer.read(roundAnswer.events);
            producer.discard(roundCall);
          }
        }),
      };
    },
  });

  const entry = asEntry(space.compose('long-react', {
    entry: { round: required<number>() },
    exit: { events: required<ManagedStream<number, never>>() },
    stages: [loop],
    ending: terminal,
  }));

  const call = host.run(entry, { round: 1 }, { services });
  const answer = await call;
  let count = 0;
  for await (const frame of host.read(answer.events)) {
    expect(frame.ok).toBe(true);
    count += 1;
  }
  expect(count).toBe(totalRounds);
  host.abort(call).discard();
  host.close();
  await settle();
  expect(errors).toEqual([]);
});

it('Claude Code retry aborts and discards a 401 HTTP call before retrying with refreshed credentials', async () => {
  type Rq = { authorization: string };
  type Rs = { status: number; body: ManagedStream<string, string> };
  const space = defineFacts<Rq, Rs>();
  const steps: string[] = [];
  const { host, services, background, errors, settle } = hostFor({});

  const dial = space.defineStage({
    name: 'http-terminal',
    request: { needs: { authorization: required<string>() } },
    return: { provides: { status: required<number>(), body: optional<ManagedStream<string, string>>() } },
    execute: async ({ authorization }, scope) => {
      steps.push(`dial:${authorization}`);
      if (authorization === 'fresh') return { status: 200 };
      scope.signal.addEventListener('abort', () => { steps.push('abort'); }, { once: true });
      return {
        status: 401,
        body: scope.createStream(async function* (producer) {
          expect(producer.signal.aborted).toBe(true);
          steps.push('drain');
          yield { ok: false, error: 'aborted' };
        }),
      };
    },
  });

  const retry = space.defineStage({
    name: 'refresh-credential',
    through: {
      request: { needs: { authorization: required<string>() }, provides: { authorization: required<string>() }, consumes: [] },
      response: { needs: { status: required<number>() }, provides: {}, consumes: [] },
    },
    execute: async (facts, scope) => {
      const firstCall = scope.next(facts);
      const answer = await firstCall;
      if (answer.status !== 401) return answer;
      scope.abort(firstCall).discard();
      expect(background).toHaveLength(1);
      return await scope.next({ ...facts, authorization: 'fresh' });
    },
  });

  const entry = asEntry(space.compose('claude-code', {
    entry: { authorization: required<string>() },
    exit: { status: required<number>(), body: optional<ManagedStream<string, string>>() },
    stages: [retry],
    ending: dial,
  }));

  const call = host.run(entry, { authorization: 'expired' }, { services });
  const answer = await call;
  expect(answer.status).toBe(200);
  host.abort(call).discard();
  host.close();
  await settle();
  expect(steps).toEqual(['dial:expired', 'abort', 'dial:fresh', 'drain']);
  expect(errors).toEqual([]);
});

it('guard discards after yield on Ok failure, encoder auto-drains on Err, and root host interrupts active upstream I/O', async () => {
  type Rs = { events: ManagedStream<string, string>; body: ManagedStream<string, never> };
  const space = defineFacts<object, Rs>();
  const { host, services, background, errors, settle } = hostFor({});
  const waitingForAbort = Promise.withResolvers<void>();
  const upstreamCancellation = new Error('delivery finished');
  const order: string[] = [];
  const finished: unknown[] = [];

  const origin = space.defineStage({
    name: 'origin',
    request: { needs: {} },
    return: { provides: { events: required<ManagedStream<string, string>>() } },
    execute: async (_facts, scope) => ({
      events: scope.createStream(async function* ({ signal }) {
        order.push('origin:malformed');
        yield { ok: true, value: 'malformed' };
        order.push('origin:drain-entered');
        const aborted = Promise.withResolvers<void>();
        const interrupt = (): void => { aborted.resolve(); };
        signal.addEventListener('abort', interrupt);
        waitingForAbort.resolve();
        try {
          await aborted.promise;
          expect(signal.reason).toBe(upstreamCancellation);
          yield { ok: false, error: 'I/O cancelled' };
        } finally {
          signal.removeEventListener('abort', interrupt);
          finished.push(signal.reason);
        }
      }),
    }),
  });

  const guard = space.defineStage({
    name: 'guard',
    through: {
      request: emptySide,
      response: {
        needs: { events: required<ManagedStream<string, string>>() },
        provides: { events: required<ManagedStream<string, string>>() },
        consumes: [],
      },
    },
    execute: async (facts, scope) => {
      const answer = await scope.next(facts);
      return {
        ...answer,
        events: scope.wrapStream(answer.events, async function* (source, producer) {
          const cursor = producer.read(source);
          for await (const event of cursor) {
            if (event.ok && event.value === 'malformed') {
              order.push('guard:yield-err');
              yield { ok: false, error: 'invalid event' };
              order.push('guard:post-yield-discard');
              cursor.discard();
              return;
            }
            yield event;
          }
        }),
      };
    },
  });

  const encoder = space.defineStage({
    name: 'encoder',
    through: {
      request: emptySide,
      response: {
        needs: { events: required<ManagedStream<string, string>>() },
        provides: { body: required<ManagedStream<string, never>>() },
        consumes: ['events'],
      },
    },
    execute: async (facts, scope) => {
      const { events, ...rest } = await scope.next(facts);
      return {
        ...rest,
        body: scope.wrapStream(events, async function* (source, producer) {
          for await (const event of producer.read(source)) {
            if (!event.ok) {
              order.push('encoder:yield-rendered');
              yield { ok: true, value: JSON.stringify({ error: event.error }) };
              return;
            }
            yield event;
          }
        }),
      };
    },
  });

  const entry = asEntry(space.compose('encode', {
    entry: {},
    exit: { body: required<ManagedStream<string, never>>() },
    stages: [encoder, guard],
    ending: origin,
  }));

  const call = host.run(entry, {}, { services });
  const answer = await call;
  const cursor = host.read(answer.body);
  await expect(cursor.next()).resolves.toEqual({ done: false, value: { ok: true, value: '{"error":"invalid event"}' } });
  expect(order).toEqual(['origin:malformed', 'guard:yield-err', 'encoder:yield-rendered']);
  await expect(cursor.next()).resolves.toEqual({ done: true, value: undefined });
  await waitingForAbort.promise;
  expect(order).toEqual([
    'origin:malformed',
    'guard:yield-err',
    'encoder:yield-rendered',
    'guard:post-yield-discard',
    'origin:drain-entered',
  ]);
  expect(finished).toEqual([]);
  expect(background).toHaveLength(2);
  host.abort(call, upstreamCancellation).discard();
  host.close();
  await settle();
  expect(finished).toEqual([upstreamCancellation]);
  expect(errors).toEqual([]);
});

it('discarded source stream panic reaches waitUntil with original error while business delivery succeeds', async () => {
  type Rs = { source: ManagedStream<string, never>; answer: string };
  const space = defineFacts<object, Rs>();
  const { host, services, errors, settle } = hostFor({});
  const draining = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const cause = new Error('original cause');
  const failure = new Error('background source failure', { cause });

  const origin = space.defineStage({
    name: 'origin',
    request: { needs: {} },
    return: { provides: { source: required<ManagedStream<string, never>>() } },
    execute: async (_facts, scope) => ({
      source: scope.createStream(async function* () {
        yield { ok: true, value: 'discarded' };
        draining.resolve();
        await release.promise;
        throw failure;
      }),
    }),
  });

  const decide = space.defineStage({
    name: 'decide',
    through: {
      request: emptySide,
      response: {
        needs: { source: required<ManagedStream<string, never>>() },
        provides: { answer: required<string>() },
        consumes: ['source'],
      },
    },
    execute: async (facts, scope) => {
      const childCall = scope.next(facts);
      const back = await childCall;
      const { source, ...rest } = back;
      scope.discard(source);
      return { ...rest, answer: 'delivered' };
    },
  });

  const entry = asEntry(space.compose('decide', {
    entry: {},
    exit: { answer: required<string>() },
    stages: [decide],
    ending: origin,
  }));

  const call = host.run(entry, {}, { services });
  const back = await call;
  expect(back).toEqual({ answer: 'delivered' });
  await draining.promise;
  expect(errors).toEqual([]);
  host.abort(call).discard();
  host.close();
  release.resolve();
  await settle();
  expect(errors).toEqual([failure]);
  expect(errors[0]).toBe(failure);
});

it('detach runs immediately with WorkerScope and live service instance, reporting original rejection to waitUntil', async () => {
  class LiveService {
    #count = 0;
    readonly persist: () => Promise<void>;

    constructor(persist: () => Promise<void>) {
      this.persist = persist;
    }

    increment(): number {
      this.#count += 1;
      return this.#count;
    }
  }

  const failure = new Error('persistence failed');
  const persist = Promise.withResolvers<void>();
  const live = new LiveService(() => persist.promise);
  const space = defineFacts<object, { answer: number }, LiveService>();
  const { host, services, background, errors, settle } = hostFor(live);
  const steps: string[] = [];

  const provider = space.defineStage({
    name: 'provider',
    request: { needs: {} },
    return: { provides: { answer: required<number>() } },
    execute: async (_facts, scope) => {
      expect(scope.services).toBe(live);
      const first = scope.services.increment();
      scope.detach(async worker => {
        expect(Object.keys(worker).sort()).toEqual(['log', 'services']);
        expect(worker.services).toBe(live);
        expect(worker.log.withField).toBeTypeOf('function');
        steps.push(`persist:${worker.services.increment()}`);
        await worker.services.persist();
      });
      steps.push(`answer:${first}`);
      return { answer: scope.services.increment() };
    },
  });

  const entry = asEntry(space.compose('provider', {
    entry: {},
    exit: { answer: required<number>() },
    stages: [],
    ending: provider,
  }));

  const call = host.run(entry, {}, { services });
  const answer = await call;
  expect(answer).toEqual({ answer: 3 });
  expect(steps).toEqual(['persist:2', 'answer:1']);
  expect(background).toHaveLength(1);
  expect(errors).toEqual([]);
  host.abort(call).discard();
  host.close();
  persist.reject(failure);
  await settle();
  expect(errors[0]).toBe(failure);
});

it('detach rejects non-Promise return values synchronously and routes synchronous callback throws to waitUntil', async () => {
  const syncFailure = new Error('sync detach throw');
  const space = defineFacts<{ mode: 'non-promise' | 'sync-throw' }, { ok: true }>();
  const { host, services, errors, settle } = hostFor({});

  const entry = asEntry(space.compose('detach-edges', {
    entry: { mode: required<'non-promise' | 'sync-throw'>() },
    exit: { ok: required<true>() },
    stages: [],
    ending: space.defineStage({
      name: 'detach-stage',
      request: { needs: { mode: required<'non-promise' | 'sync-throw'>() } },
      return: { provides: { ok: required<true>() } },
      execute: async ({ mode }, scope) => {
        if (mode === 'non-promise') {
          scope.detach(() => 'not-a-promise' as unknown as Promise<void>);
        } else {
          scope.detach(() => { throw syncFailure; });
        }
        return { ok: true };
      },
    }),
  }));

  await expect(host.run(entry, { mode: 'non-promise' }, { services }))
    .rejects.toThrow('A pipeline detach worker must return a Promise');

  const call = host.run(entry, { mode: 'sync-throw' }, { services });
  expect(await call).toEqual({ ok: true });
  host.discard(call);
  host.close();
  await settle();
  expect(errors).toEqual([syncFailure]);
  expect(errors[0]).toBe(syncFailure);
});

it('wrapStream and wrapDeferred invoke factories synchronously, transfer inner handles, and return fresh handles', async () => {
  type Rs = { stream: ManagedStream<number, never>; metadata: Deferred<{ count: number }> };
  const space = defineFacts<object, Rs>();
  const { host, services, background } = hostFor({});
  const factories: string[] = [];

  const terminal = space.defineStage({
    name: 'terminal',
    request: { needs: {} },
    return: {
      provides: {
        stream: required<ManagedStream<number, never>>(),
        metadata: required<Deferred<{ count: number }>>(),
      },
    },
    execute: async (_facts, scope) => ({
      stream: scope.createStream(() => {
        factories.push('create stream');
        return (async function* () { yield { ok: true, value: 3 } as const; })();
      }),
      metadata: scope.createDeferred(async () => {
        factories.push('create deferred');
        return { count: 5 };
      }),
    }),
  });

  const wrapper = space.defineStage({
    name: 'wrapper',
    through: {
      request: emptySide,
      response: {
        needs: {
          stream: required<ManagedStream<number, never>>(),
          metadata: required<Deferred<{ count: number }>>(),
        },
        provides: {
          stream: required<ManagedStream<number, never>>(),
          metadata: required<Deferred<{ count: number }>>(),
        },
        consumes: [],
      },
    },
    execute: async (facts, scope) => {
      const back = await scope.next(facts);
      const stream = scope.wrapStream(back.stream, (source, producer) => {
        factories.push('wrap stream');
        expect(() => scope.read(source)).toThrow('without custody');
        return (async function* () {
          for await (const item of producer.read(source)) {
            if (item.ok) yield { ok: true, value: item.value * 2 } as const;
          }
        })();
      });
      const metadata = scope.wrapDeferred(back.metadata, async (source, producer) => {
        factories.push('wrap deferred');
        const shared = producer.read(source);
        const [left, right] = await Promise.all([shared.then(v => v.count), shared.then(v => v.count)]);
        return { count: left + right };
      });
      expect(stream).not.toBe(back.stream);
      expect(metadata).not.toBe(back.metadata);
      return { ...back, stream, metadata };
    },
  });

  const entry = asEntry(space.compose('wrap', {
    entry: {},
    exit: {
      stream: required<ManagedStream<number, never>>(),
      metadata: required<Deferred<{ count: number }>>(),
    },
    stages: [wrapper],
    ending: terminal,
  }));

  const call = host.run(entry, {}, { services });
  const answer = await call;
  expect(factories).toEqual(['create stream', 'create deferred', 'wrap stream', 'wrap deferred']);
  await expect(host.read(answer.metadata)).resolves.toEqual({ count: 10 });
  const cursor = host.read(answer.stream);
  await expect(cursor.next()).resolves.toEqual({ done: false, value: { ok: true, value: 6 } });
  await expect(cursor.next()).resolves.toEqual({ done: true, value: undefined });
  host.abort(call).discard();
  host.close();
  expect(background).toHaveLength(0);
});

it.each(['resolve', 'panic'] as const)(
  'throwing execute discards orphaned wrapped handles and handles late child %s via waitUntil',
  async lateOutcome => {
    type Rq = { attempt: number };
    type Rs = { stream: ManagedStream<string, never>; metadata: Deferred<number> };
    const space = defineFacts<Rq, Rs>();
    const { host, services, errors, settle } = hostFor({});
    const late = Promise.withResolvers<void>();
    const usage = Promise.withResolvers<number>();
    const events: string[] = [];
    const executeFailure = new Error('execute failed while holding resources');
    const orphanPanic = new Error('orphaned child panicked late');

    const terminal = space.defineStage({
      name: 'child',
      request: { needs: { attempt: required<number>() } },
      return: {
        provides: {
          stream: required<ManagedStream<string, never>>(),
          metadata: optional<Deferred<number>>(),
        },
      },
      execute: async ({ attempt }, scope) => {
        events.push(`call:${attempt}`);
        if (attempt === 2) {
          await late.promise;
          if (lateOutcome === 'panic') throw orphanPanic;
        }
        return {
          stream: scope.createStream(async function* () {
            try {
              yield { ok: true, value: 'orphan' };
            } finally {
              events.push(`stream:${attempt}`);
            }
          }),
          metadata: scope.createDeferred(async () => {
            if (attempt === 1) return 1;
            const value = await usage.promise;
            events.push('late metadata');
            return value;
          }),
        };
      },
    });

    const stage = space.defineStage({
      name: 'abandon',
      through: {
        request: { needs: { attempt: required<number>() }, provides: { attempt: required<number>() }, consumes: [] },
        response: { needs: { stream: required<ManagedStream<string, never>>() }, provides: {}, consumes: [] },
      },
      execute: async (facts, scope) => {
        const first = await scope.next(facts);
        scope.wrapStream(first.stream, async function* (source, producer) {
          try {
            yield* producer.read(source);
          } finally {
            events.push('wrapped stream');
          }
        });
        void scope.next({ ...facts, attempt: 2 });
        throw executeFailure;
      },
    });

    const entry = asEntry(space.compose('orphan', {
      entry: { attempt: required<number>() },
      exit: {
        stream: required<ManagedStream<string, never>>(),
        metadata: optional<Deferred<number>>(),
      },
      stages: [stage],
      ending: terminal,
    }));

    const call = host.run(entry, { attempt: 1 }, { services });
    await expect(call).rejects.toBe(executeFailure);
    host.close();
    expect(events).toContain('call:2');
    late.resolve();
    usage.resolve(2);
    await settle();
    if (lateOutcome === 'resolve') {
      expect(events).toEqual(expect.arrayContaining(['stream:1', 'wrapped stream', 'stream:2', 'late metadata']));
      expect(errors).toEqual([]);
    } else {
      expect(events).toEqual(expect.arrayContaining(['stream:1', 'wrapped stream']));
      expect(errors).toEqual([orphanPanic]);
      expect(errors[0]).toBe(orphanPanic);
    }
  },
);

it('queued stream reads and opened deferred still deliver after call discard, drain follows, and new reads fail custody', async () => {
  type Rs = { stream: ManagedStream<number, never>; usage: Deferred<number> };
  const space = defineFacts<object, Rs>();
  const { host, services, background, errors, settle } = hostFor({});
  const firstStarted = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const deferred = Promise.withResolvers<number>();
  const reads: string[] = [];

  const terminal = space.defineStage({
    name: 'queue',
    request: { needs: {} },
    return: {
      provides: {
        stream: required<ManagedStream<number, never>>(),
        usage: required<Deferred<number>>(),
      },
    },
    execute: async (_facts, scope) => ({
      stream: scope.createStream(async function* () {
        reads.push('first entered');
        firstStarted.resolve();
        await releaseFirst.promise;
        yield { ok: true, value: 1 };
        reads.push('second entered');
        yield { ok: true, value: 2 };
        reads.push('drain entered');
        yield { ok: true, value: 3 };
        reads.push('native done');
      }),
      usage: scope.createDeferred(() => deferred.promise),
    }),
  });

  const entry = asEntry(space.compose('queue', {
    entry: {},
    exit: {
      stream: required<ManagedStream<number, never>>(),
      usage: required<Deferred<number>>(),
    },
    stages: [],
    ending: terminal,
  }));

  const call = host.run(entry, {}, { services });
  const answer = await call;
  const cursor = host.read(answer.stream);
  const first = cursor.next();
  const second = cursor.next();
  const usage = host.read(answer.usage);
  await firstStarted.promise;
  expect(reads).toEqual(['first entered']);

  host.discard(call);
  await expect(cursor.next()).rejects.toThrow('without custody');
  expect(() => host.read(answer.usage)).toThrow('without custody');
  expect(background).toHaveLength(1);

  releaseFirst.resolve();
  deferred.resolve(6);
  await expect(first).resolves.toEqual({ done: false, value: { ok: true, value: 1 } });
  await expect(second).resolves.toEqual({ done: false, value: { ok: true, value: 2 } });
  await expect(usage).resolves.toBe(6);
  host.discard(call);
  host.close();
  await settle();
  expect(reads).toEqual(['first entered', 'second entered', 'drain entered', 'native done']);
  expect(errors).toEqual([]);
  expect(background).toHaveLength(1);
});

it('parent cancellation propagates atomically to active children and transitions retained settled child signal', async () => {
  type Role = 'finished' | 'first' | 'second';
  type Rq = { role: Role };
  type Rs = { result: true; work: Deferred<void> };
  const space = defineFacts<Rq, Rs>();
  const { controller, host, services, errors, settle } = hostFor({});
  const signals = new Map<Role, AbortSignal>();
  const active = new Set<Role>();
  const interrupted: Role[] = [];
  const reason = new Error('client disconnected');

  const terminal = space.defineStage({
    name: 'bind-io',
    request: { needs: { role: required<Role>() } },
    return: { provides: { result: required<true>(), work: optional<Deferred<void>>() } },
    execute: async ({ role }, scope) => {
      const { signal } = scope;
      signals.set(role, signal);
      const interruption = Promise.withResolvers<void>();
      const listener = (): void => {
        interrupted.push(role);
        const peer = signals.get(role === 'first' ? 'second' : 'first')!;
        expect(peer.aborted).toBe(true);
        expect(peer.reason).toBe(reason);
        expect(signal.reason).toBe(reason);
        interruption.resolve();
      };
      const unbind = (): void => {
        signal.removeEventListener('abort', listener);
        active.delete(role);
      };
      signal.addEventListener('abort', listener);
      active.add(role);
      if (role === 'finished') {
        unbind();
        return { result: true };
      }
      return { result: true, work: scope.createDeferred(() => interruption.promise.finally(unbind)) };
    },
  });

  const fanout = space.defineStage({
    name: 'fanout',
    through: {
      request: { needs: { role: required<Role>() }, provides: { role: required<Role>() }, consumes: [] },
      response: {
        needs: { result: required<true>(), work: optional<Deferred<void>>() },
        provides: {},
        consumes: ['work'],
      },
    },
    return: { provides: { result: required<true>() } },
    execute: async (facts, scope) => {
      const finishedCall = scope.next(facts);
      await finishedCall;
      scope.abort(finishedCall);
      scope.abort(finishedCall);
      expect(signals.get('finished')?.aborted).toBe(false);
      expect(active.has('finished')).toBe(false);
      scope.discard(finishedCall);

      const first = scope.next({ ...facts, role: 'first' });
      const second = scope.next({ ...facts, role: 'second' });
      expect(first).not.toBe(second);
      expect(() => scope.abort(first.then(v => v))).toThrow('original promise');
      await first;
      await second;
      scope.discard(first);
      scope.discard(second);
      return { result: true };
    },
  });

  const entry = asEntry(space.compose('fanout', {
    entry: { role: required<Role>() },
    exit: { result: required<true>() },
    stages: [fanout],
    ending: terminal,
  }));

  const call = host.run(entry, { role: 'finished' }, { services });
  await call;
  expect(active).toEqual(new Set(['first', 'second']));
  expect(signals.get('finished')?.aborted).toBe(false);
  controller.abort(reason);
  expect(interrupted.toSorted()).toEqual(['first', 'second']);
  expect(signals.get('finished')?.aborted).toBe(true);
  expect(signals.get('finished')?.reason).toBe(reason);
  host.discard(call);
  host.close();
  await settle();
  expect(active.size).toBe(0);
  expect(errors).toEqual([]);
});

it.each(['resolve', 'panic'] as const)(
  'active caller abandons pending child via abort(call).discard() and continues while late %s settles in background',
  async outcome => {
    type Rq = { mode: 'slow' | 'fast' };
    type Rs = { value: string; stream: ManagedStream<string, never> };
    const space = defineFacts<Rq, Rs>();
    const { host, services, errors, settle } = hostFor({});
    const releaseSlow = Promise.withResolvers<void>();
    const releaseCaller = Promise.withResolvers<void>();
    const slowSettled = Promise.withResolvers<void>();
    const drained: string[] = [];
    const slowPanic = new Error('abandoned pending child failed');

    const child = space.defineStage({
      name: 'child',
      request: { needs: { mode: required<'slow' | 'fast'>() } },
      return: {
        provides: {
          value: required<string>(),
          stream: optional<ManagedStream<string, never>>(),
        },
      },
      execute: async ({ mode }, scope) => {
        if (mode === 'fast') return { value: 'fast-answer' };
        await releaseSlow.promise;
        expect(scope.signal.aborted).toBe(true);
        if (outcome === 'panic') {
          slowSettled.resolve();
          throw slowPanic;
        }
        return {
          value: 'slow-answer',
          stream: scope.createStream(async function* () {
            try {
              yield { ok: true, value: 'ignored' };
            } finally {
              drained.push('slow-stream-drained');
              slowSettled.resolve();
            }
          }),
        };
      },
    });

    const caller = space.defineStage({
      name: 'caller',
      through: {
        request: { needs: { mode: required<'slow' | 'fast'>() }, provides: { mode: required<'slow' | 'fast'>() }, consumes: [] },
        response: { needs: { value: required<string>() }, provides: {}, consumes: [] },
      },
      execute: async (facts, scope) => {
        const pending = scope.next({ ...facts, mode: 'slow' });
        scope.abort(pending, 'cancelled-early').discard();
        releaseSlow.resolve();
        await slowSettled.promise;
        await releaseCaller.promise;
        return await scope.next({ ...facts, mode: 'fast' });
      },
    });

    const entry = asEntry(space.compose('abandon-pending', {
      entry: { mode: required<'slow' | 'fast'>() },
      exit: {
        value: required<string>(),
        stream: optional<ManagedStream<string, never>>(),
      },
      stages: [caller],
      ending: child,
    }));

    const call = host.run(entry, { mode: 'slow' }, { services });
    await slowSettled.promise;
    await settle();
    if (outcome === 'panic') {
      expect(errors).toEqual([slowPanic]);
      expect(errors[0]).toBe(slowPanic);
    } else {
      expect(drained).toEqual(['slow-stream-drained']);
      expect(errors).toEqual([]);
    }
    releaseCaller.resolve();
    expect(await call).toEqual({ value: 'fast-answer' });
    host.abort(call).discard();
    host.close();
    await settle();
  },
);

it('enforces open-set destination invariant, canary handoff verification, and intact aborted forwarding', async () => {
  type Rq = { mode: 'two' | 'pending' | 'run' | 'drop-canary' | 'abort-forward' | 'abort-spread' };
  type Rs = { value: string };
  const space = defineFacts<Rq, Rs>();
  const canary = createResponseCanary(space);

  const subSpace = defineFacts<object, { sub: number }>();
  const subEntry = asEntry(subSpace.compose('sub', {
    entry: {},
    exit: { sub: required<number>() },
    stages: [],
    ending: subSpace.defineStage({
      name: 'sub-end',
      request: { needs: {} },
      return: { provides: { sub: required<number>() } },
      execute: async () => ({ sub: 1 }),
    }),
  }));

  const pendingGate = Promise.withResolvers<void>();
  const terminal = space.defineStage({
    name: 'terminal',
    request: { needs: { mode: required<Rq['mode']>() } },
    return: { provides: { value: required<string>() } },
    execute: async ({ mode }) => {
      if (mode === 'pending') await pendingGate.promise;
      return { value: 'child' };
    },
  });

  const subject = space.defineStage({
    name: 'subject',
    through: {
      request: { needs: { mode: required<Rq['mode']>() }, provides: {}, consumes: [] },
      response: { needs: { value: required<string>() }, provides: { value: optional<string>() }, consumes: [] },
    },
    return: { provides: { value: required<string>() } },
    execute: async (facts, scope) => {
      if (facts.mode === 'two') {
        const a = await scope.next(facts);
        await scope.next(facts);
        return a;
      }
      if (facts.mode === 'pending') {
        void scope.next(facts);
        return { value: 'in-place' };
      }
      if (facts.mode === 'run') {
        await scope.run(subEntry, {}, { services: {} });
        return { value: 'in-place' };
      }
      if (facts.mode === 'drop-canary') {
        await scope.next(facts);
        return { value: 'overwritten-without-spread' };
      }
      const childCall = scope.next(facts);
      const back = await childCall;
      scope.abort(childCall);
      return facts.mode === 'abort-forward' ? back : { ...back, value: 'updated-aborted' };
    },
  });

  const entry = asEntry(canary.space.compose('invariant', {
    entry: { mode: required<Rq['mode']>() },
    exit: { value: required<string>() },
    stages: [canary.strip, subject, canary.inject],
    ending: terminal,
  }));

  const { host, services, errors, settle } = hostFor({});
  await expect(host.run(entry, { mode: 'two' }, { services })).rejects.toThrow('2 undiscarded continuation');
  await expect(host.run(entry, { mode: 'pending' }, { services })).rejects.toThrow('1 undiscarded pending child call');
  await expect(host.run(entry, { mode: 'run' }, { services })).rejects.toThrow('1 undiscarded sub-request run');
  await expect(host.run(entry, { mode: 'drop-canary' }, { services })).rejects.toThrow('removed or changed undeclared "__floway_pipeline_response_canary__"');

  const fwd = host.run(entry, { mode: 'abort-forward' }, { services });
  expect(await fwd).toEqual({ value: 'child' });
  host.discard(fwd);

  const spread = host.run(entry, { mode: 'abort-spread' }, { services });
  expect(await spread).toEqual({ value: 'updated-aborted' });
  host.discard(spread);

  host.close();
  pendingGate.resolve();
  await settle();
  expect(errors).toEqual([]);
});

it('handles for-await break cleanup, Err auto-drain, eager cursor.discard(), yield-after-Err, Ok leak, and no forced generator.return()', async () => {
  type Rs = { body: ManagedStream<number, string> };
  const space = defineFacts<object, Rs>();

  {
    const visited: number[] = [];
    const { host, services, errors, settle } = hostFor({});
    const entry = asEntry(space.compose('break-cleanup', {
      entry: {},
      exit: { body: required<ManagedStream<number, string>>() },
      stages: [],
      ending: space.defineStage({
        name: 'src',
        request: { needs: {} },
        return: { provides: { body: required<ManagedStream<number, string>>() } },
        execute: async (_f, scope) => ({
          body: scope.createStream(async function* () {
            for (const n of [1, 2, 3]) {
              visited.push(n);
              yield { ok: true, value: n };
            }
          }),
        }),
      }),
    }));
    const call = host.run(entry, {}, { services });
    const answer = await call;
    const cursor = host.read(answer.body);
    try {
      for await (const item of cursor) {
        expect(item).toEqual({ ok: true, value: 1 });
        break;
      }
    } finally {
      cursor.discard();
    }
    host.discard(call);
    host.close();
    await settle();
    expect(visited).toEqual([1, 2, 3]);
    expect(errors).toEqual([]);
  }

  {
    const drainStarted = Promise.withResolvers<void>();
    const { host, services, errors, settle } = hostFor({});
    const entry = asEntry(space.compose('eager-err-discard', {
      entry: {},
      exit: { body: required<ManagedStream<number, string>>() },
      stages: [],
      ending: space.defineStage({
        name: 'src',
        request: { needs: {} },
        return: { provides: { body: required<ManagedStream<number, string>>() } },
        execute: async (_f, scope) => ({
          body: scope.createStream(async function* () {
            yield { ok: false, error: 'boom' };
            drainStarted.resolve();
          }),
        }),
      }),
    }));
    const call = host.run(entry, {}, { services });
    const answer = await call;
    const cursor = host.read(answer.body);
    await expect(cursor.next()).resolves.toEqual({ done: false, value: { ok: false, error: 'boom' } });
    cursor.discard();
    await drainStarted.promise;
    host.discard(call);
    host.close();
    await settle();
    expect(errors).toEqual([]);
  }

  {
    const { host, services, errors, settle } = hostFor({});
    const entry = asEntry(space.compose('continue-after-err-done', {
      entry: {},
      exit: { body: required<ManagedStream<number, string>>() },
      stages: [],
      ending: space.defineStage({
        name: 'src',
        request: { needs: {} },
        return: { provides: { body: required<ManagedStream<number, string>>() } },
        execute: async (_f, scope) => ({
          body: scope.createStream(async function* () {
            yield { ok: false, error: 'clean-err' };
          }),
        }),
      }),
    }));
    const call = host.run(entry, {}, { services });
    const answer = await call;
    const cursor = host.read(answer.body);
    await expect(cursor.next()).resolves.toEqual({ done: false, value: { ok: false, error: 'clean-err' } });
    await expect(cursor.next()).resolves.toEqual({ done: true, value: undefined });
    host.discard(call);
    host.close();
    await settle();
    expect(errors).toEqual([]);
  }

  {
    const sourcePanic = new Error('mid-stream crash');
    const { host, services, errors, settle } = hostFor({});
    const entry = asEntry(space.compose('catch-mid-stream-panic', {
      entry: {},
      exit: { body: required<ManagedStream<number, string>>() },
      stages: [
        space.defineStage({
          name: 'encode-panic',
          through: {
            request: emptySide,
            response: {
              needs: { body: required<ManagedStream<number, string>>() },
              provides: { body: required<ManagedStream<number, string>>() },
              consumes: [],
            },
          },
          execute: async (facts, scope) => {
            const back = await scope.next(facts);
            return {
              ...back,
              body: scope.wrapStream(back.body, async function* (source, producer) {
                try {
                  yield* producer.read(source);
                } catch {
                  yield { ok: true, value: -1 };
                  producer.discard(source);
                }
              }),
            };
          },
        }),
      ],
      ending: space.defineStage({
        name: 'src',
        request: { needs: {} },
        return: { provides: { body: required<ManagedStream<number, string>>() } },
        execute: async (_f, scope) => ({
          body: scope.createStream(async function* () {
            yield { ok: true, value: 1 };
            throw sourcePanic;
          }),
        }),
      }),
    }));
    const call = host.run(entry, {}, { services });
    const answer = await call;
    const frames: Result<number, string>[] = [];
    for await (const frame of host.read(answer.body)) frames.push(frame);
    expect(frames).toEqual([{ ok: true, value: 1 }, { ok: true, value: -1 }]);
    host.discard(call);
    host.close();
    await settle();
    expect(errors).toEqual([]);
  }

  {
    const execution: string[] = [];
    const { host, services, errors, settle } = hostFor({});
    const entry = asEntry(space.compose('yield-after-err', {
      entry: {},
      exit: { body: required<ManagedStream<number, string>>() },
      stages: [],
      ending: space.defineStage({
        name: 'src',
        request: { needs: {} },
        return: { provides: { body: required<ManagedStream<number, string>>() } },
        execute: async (_f, scope) => ({
          body: scope.createStream(async function* () {
            try {
              yield { ok: false, error: 'expected' };
              yield { ok: true, value: 99 };
              execution.push('after-illegal-yield');
            } finally {
              execution.push('finally-ran');
            }
          }),
        }),
      }),
    }));
    const call = host.run(entry, {}, { services });
    const answer = await call;
    const cursor = host.read(answer.body);
    await expect(cursor.next()).resolves.toEqual({ done: false, value: { ok: false, error: 'expected' } });
    const illegal = cursor.next();
    const queued = cursor.next();
    await expect(illegal).rejects.toThrow('yielded after Err');
    await expect(queued).rejects.toThrow('yielded after Err');
    await expect(cursor.next()).rejects.toThrow('yielded after Err');
    host.discard(call);
    host.close();
    await settle();
    expect(execution).toEqual([]);
    expect(errors).toEqual([]);
  }

  {
    const { host, services, errors, settle } = hostFor({});
    const entry = asEntry(space.compose('ok-leak', {
      entry: {},
      exit: { body: required<ManagedStream<number, string>>() },
      stages: [],
      ending: space.defineStage({
        name: 'src',
        request: { needs: {} },
        return: { provides: { body: required<ManagedStream<number, string>>() } },
        execute: async (_f, scope) => ({
          body: scope.createStream(async function* () {
            yield { ok: true, value: 1 };
            yield { ok: true, value: 2 };
          }),
        }),
      }),
    }));
    const call = host.run(entry, {}, { services });
    const answer = await call;
    let reachedAfterLoop = false;
    for await (const item of host.read(answer.body)) {
      expect(item).toEqual({ ok: true, value: 1 });
      break;
    }
    reachedAfterLoop = true;
    expect(reachedAfterLoop).toBe(true);
    expect(() => host.close()).toThrow('HostScope closed with 1 undiscarded run(s) and 1 leaked handle(s)');
    await settle();
    expect(errors).toEqual([]);
  }
});

it('root HostScope and scope.run enforce checkEntry, explicit services, single-handle discard, Err close drain, abandoned pending root panic, and host.close() leak checks', async () => {
  interface SubSvc { readonly label: string }
  interface ParentSvc { readonly parentLabel: string }
  type SubAction = 'ok' | 'extra-entry' | 'missing-entry' | 'missing-services' | 'null-services' | 'primitive-services';
  const subSpace = defineFacts<{ query: string }, { reply: string; stream: ManagedStream<string, string> }, SubSvc>();
  const parentSpace = defineFacts<{ query: string; action: SubAction }, { reply: string }, ParentSvc>();

  const subEntry = asEntry(subSpace.compose('sub-entry', {
    entry: { query: required<string>() },
    exit: { reply: required<string>(), stream: optional<ManagedStream<string, string>>() },
    stages: [],
    ending: subSpace.defineStage({
      name: 'sub-end',
      request: { needs: { query: required<string>() } },
      return: { provides: { reply: required<string>(), stream: optional<ManagedStream<string, string>>() } },
      execute: async ({ query }, scope) => ({
        reply: `${scope.services.label}:${query}`,
        stream: scope.createStream(async function* () {
          yield { ok: true, value: query };
          yield { ok: false, error: 'done-err' };
        }),
      }),
    }),
  }));

  const parentEntry = asEntry(parentSpace.compose('parent-entry', {
    entry: { query: required<string>(), action: required<SubAction>() },
    exit: { reply: required<string>() },
    stages: [],
    ending: parentSpace.defineStage({
      name: 'parent-end',
      request: { needs: { query: required<string>(), action: required<SubAction>() } },
      return: { provides: { reply: required<string>() } },
      execute: async ({ query, action }, scope) => {
        if (action === 'extra-entry') {
          await scope.run(subEntry, { query, extra: 'illegal' } as unknown as { query: string }, { services: { label: 'isolated' } });
        }
        if (action === 'missing-entry') {
          await scope.run(subEntry, {} as unknown as { query: string }, { services: { label: 'isolated' } });
        }
        if (action === 'missing-services') {
          await scope.run(subEntry, { query }, {} as never);
        }
        if (action === 'null-services') {
          await scope.run(subEntry, { query }, { services: null } as never);
        }
        if (action === 'primitive-services') {
          await scope.run(subEntry, { query }, { services: 'bad' } as never);
        }
        const subCall = scope.run(subEntry, { query }, { services: { label: `sub-for-${scope.services.parentLabel}` } });
        const subAnswer = await subCall;
        scope.discard(subAnswer.stream!);
        scope.abort(subCall).discard();
        return { reply: subAnswer.reply };
      },
    }),
  }));

  {
    const { host, services, errors, settle } = hostFor<ParentSvc>({ parentLabel: 'root' });
    expect(() => host.run(parentEntry, { query: 'q', action: 'ok' }, undefined as never))
      .toThrow('Expected explicit { services } for pipeline run');
    expect(() => host.run(parentEntry, { query: 'q', action: 'ok' }, {} as never))
      .toThrow('Expected explicit { services } for pipeline run');
    expect(() => host.run(parentEntry, { query: 'q', action: 'ok' }, { services: null } as never))
      .toThrow('Expected explicit { services } for pipeline run');
    expect(() => host.run(parentEntry, { query: 'q', action: 'ok' }, { services: 42 } as never))
      .toThrow('Expected explicit { services } for pipeline run');

    await expect(host.run(parentEntry, { query: 'q', action: 'missing-services' }, { services }))
      .rejects.toThrow('Expected explicit { services } for pipeline run');
    await expect(host.run(parentEntry, { query: 'q', action: 'null-services' }, { services }))
      .rejects.toThrow('Expected explicit { services } for pipeline run');
    await expect(host.run(parentEntry, { query: 'q', action: 'primitive-services' }, { services }))
      .rejects.toThrow('Expected explicit { services } for pipeline run');

    await expect(host.run(parentEntry, { query: 'q', action: 'ok', extra: 1 } as never, { services }))
      .rejects.toThrow('Pipeline "parent-entry" entry received undeclared "extra"');
    await expect(host.run(parentEntry, { action: 'ok' } as never, { services }))
      .rejects.toThrow('Pipeline "parent-entry" entry is missing "query"');
    await expect(host.run(parentEntry, { query: 'q', action: 'extra-entry' }, { services }))
      .rejects.toThrow('Pipeline "sub-entry" entry received undeclared "extra"');
    await expect(host.run(parentEntry, { query: 'q', action: 'missing-entry' }, { services }))
      .rejects.toThrow('Pipeline "sub-entry" entry is missing "query"');

    const okCall = host.run(parentEntry, { query: 'hello', action: 'ok' }, { services });
    expect(await okCall).toEqual({ reply: 'sub-for-root:hello' });
    host.abort(okCall).discard();

    const subDirect = host.run(subEntry, { query: 'direct' }, { services: { label: 'root-direct' } });
    const subDirectAnswer = await subDirect;
    host.discard(subDirectAnswer.stream!);
    host.discard(subDirect);
    host.close();
    await settle();
    expect(errors).toEqual([]);
  }

  {
    const drainFinished = Promise.withResolvers<void>();
    let drainedAfterErr = false;
    const errStreamSpace = defineFacts<object, { stream: ManagedStream<string, string> }>();
    const errStreamEntry = asEntry(errStreamSpace.compose('err-close-drain', {
      entry: {},
      exit: { stream: required<ManagedStream<string, string>>() },
      stages: [],
      ending: errStreamSpace.defineStage({
        name: 'err-stream-end',
        request: { needs: {} },
        return: { provides: { stream: required<ManagedStream<string, string>>() } },
        execute: async (_facts, scope) => ({
          stream: scope.createStream(async function* () {
            yield { ok: true, value: 'err-tail' };
            yield { ok: false, error: 'done-err' };
            drainedAfterErr = true;
            drainFinished.resolve();
          }),
        }),
      }),
    }));
    const { host, services, errors, settle } = hostFor({});
    const subErr = host.run(errStreamEntry, {}, { services });
    const subErrAnswer = await subErr;
    const errCursor = host.read(subErrAnswer.stream);
    await expect(errCursor.next()).resolves.toEqual({ done: false, value: { ok: true, value: 'err-tail' } });
    await expect(errCursor.next()).resolves.toEqual({ done: false, value: { ok: false, error: 'done-err' } });
    expect(drainedAfterErr).toBe(false);
    expect(() => host.close()).toThrow(/^HostScope closed with 1 undiscarded run\(s\)$/);
    await drainFinished.promise;
    await settle();
    expect(drainedAfterErr).toBe(true);
    expect(errors).toEqual([]);
  }

  {
    const panic = new Error('abandoned root run exploded');
    const gate = Promise.withResolvers<void>();
    const panicSpace = defineFacts<object, { ok: boolean }>();
    const panicEntry = asEntry(panicSpace.compose('panic-root', {
      entry: {},
      exit: { ok: required<boolean>() },
      stages: [],
      ending: panicSpace.defineStage({
        name: 'panic-end',
        request: { needs: {} },
        return: { provides: { ok: required<boolean>() } },
        execute: async () => {
          await gate.promise;
          throw panic;
        },
      }),
    }));

    const controller = new AbortController();
    const background: Promise<unknown>[] = [];
    const errors: unknown[] = [];
    const host = createHostScope({
      signal: controller.signal,
      waitUntil: work => { background.push(work.catch(e => { errors.push(e); })); },
    });

    const pendingRun = host.run(panicEntry, {}, { services: {} });
    host.abort(pendingRun, 'client-gone').discard();
    gate.resolve();
    await Promise.all(background);
    expect(errors).toEqual([panic]);
    expect(errors[0]).toBe(panic);
    expect(() => host.close()).not.toThrow();
  }

  {
    const scalarSpace = defineFacts<object, { ok: boolean }>();
    const scalarEntry = asEntry(scalarSpace.compose('scalar', {
      entry: {},
      exit: { ok: required<boolean>() },
      stages: [],
      ending: scalarSpace.defineStage({
        name: 'scalar-end',
        request: { needs: {} },
        return: { provides: { ok: required<boolean>() } },
        execute: async () => ({ ok: true }),
      }),
    }));
    const { host, services } = hostFor({});
    const call = host.run(scalarEntry, {}, { services });
    expect(await call).toEqual({ ok: true });
    expect(() => host.close()).toThrow('HostScope closed with 1 undiscarded run(s)');
  }
});

it('keeps a borrowed stream abortable on its child call through live use and discard drain', async () => {
  type Rq = { body: ManagedStream<string, never> };
  type Rs = { delivered: number };
  const space = defineFacts<Rq, Rs>();
  const { host, services, errors, settle } = hostFor({});
  const draining = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const failure = new Error('borrowed drain failed');
  const signals: AbortSignal[] = [];

  const discardStage = space.defineStage({
    name: 'discard-body',
    request: { needs: { body: required<ManagedStream<string, never>>() } },
    return: { provides: { delivered: required<number>() } },
    execute: async ({ body }, scope) => {
      signals.push(scope.signal);
      scope.discard(body);
      return { delivered: 1 };
    },
  });

  const stage = space.defineStage({
    name: 'call-with-body',
    through: {
      request: { needs: {}, provides: { body: required<ManagedStream<string, never>>() }, consumes: [] },
      response: { needs: { delivered: required<number>() }, provides: {}, consumes: [] },
    },
    execute: async (facts, scope) => {
      const body = scope.createStream(async function* (producer) {
        yield { ok: true, value: 'discarded' };
        draining.resolve();
        await finish.promise;
        expect(producer.signal.aborted).toBe(true);
        throw failure;
      });
      const call = scope.next({ ...facts, body });
      const answer = await call;
      await draining.promise;
      expect(signals[0]?.aborted).toBe(false);
      scope.abort(call);
      expect(signals[0]?.aborted).toBe(true);
      expect(scope.signal.aborted).toBe(false);
      return answer;
    },
  });

  const entry = asEntry(space.compose('discard-borrowed', {
    entry: {},
    exit: { delivered: required<number>() },
    stages: [stage],
    ending: discardStage,
  }));

  const call = host.run(entry, {}, { services });
  expect(await call).toEqual({ delivered: 1 });
  expect(errors).toEqual([]);
  host.abort(call).discard();
  host.close();
  finish.resolve();
  await settle();
  expect(errors[0]).toBe(failure);
});
