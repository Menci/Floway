import { expect, it } from 'vitest';

import { emptySide, hostFor } from './run-fixture.ts';
import { asEntry, factSpace, run } from '../src/index.ts';
import type { Deferred, ManagedStream, Result } from '../src/index.ts';

it('aborts and discards an entire losing answer before retrying its suffix', async () => {
  type Request = { candidate: number };
  type Response = {
    outcome: 'retry' | 'selected';
    source: ManagedStream<string, string>;
    metadata: { usage: Deferred<number> };
  };
  const { defineStage, compose } = factSpace<Request, Response>();
  const host = hostFor({});
  const attempts: number[] = [];
  const stopped: boolean[] = [];
  const deferred = Promise.withResolvers<number>();
  const attemptsStage = defineStage({
    name: 'attempt',
    request: { needs: ['candidate'] },
    return: { provides: ['outcome', 'source?', 'metadata?'] },
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
  const failover = defineStage({
    name: 'failover',
    through: {
      request: { ...emptySide, needs: ['candidate'], provides: ['candidate'] },
      response: { ...emptySide, needs: ['outcome'] },
    },
    execute: async (facts, scope) => {
      const call = scope.next(facts);
      const losing = await call;
      expect(losing.outcome).toBe('retry');
      scope.abort(call);
      scope.discard(losing);
      return await scope.next({ ...facts, candidate: 2 });
    },
  });
  const entry = asEntry(compose('failover', {
    entry: ['candidate'], exit: ['outcome', 'source?', 'metadata?'], stages: [failover], ending: attemptsStage,
  }));

  const running = run(entry, { candidate: 1 }, host.options);
  const answer = await running.result;
  expect(answer).toEqual({ outcome: 'selected' });
  expect(attempts).toEqual([1, 2]);
  expect(host.background).toHaveLength(2);
  host.controller.abort();
  running.discard(answer);
  deferred.resolve(7);
  await host.settle();
  expect(stopped).toEqual([true]);
  expect(host.errors).toEqual([]);
});

it.each([false, true])('collects a scalar or propagates a live read panic (panic=%s)', async panics => {
  type Response = { body: ManagedStream<string, never>; scalar: string };
  const { defineStage, compose } = factSpace<object, Response>();
  const failure = new Error('source read panic');
  const drain = Promise.withResolvers<void>();
  const draining = Promise.withResolvers<void>();
  const host = hostFor({});
  const source = defineStage({
    name: 'source',
    request: { needs: [] },
    return: { provides: ['body'] },
    execute: async (_facts, scope) => ({
      body: scope.createStream(async function* () {
        if (panics) throw failure;
        yield { ok: true, value: 'first' };
        draining.resolve();
        await drain.promise;
        yield { ok: true, value: 'discarded' };
      }),
    }),
  });
  const collector = defineStage({
    name: 'collector',
    through: { request: emptySide, response: { needs: ['body'], provides: ['scalar'], consumes: ['body'] } },
    execute: async (facts, scope) => {
      const answer = await scope.next(facts);
      const { body, ...rest } = answer;
      const head = await scope.read(body).next();
      if (head.done || !head.value.ok) throw new Error('Expected the first frame');
      scope.discard(answer);
      return { ...rest, scalar: head.value.value };
    },
  });
  const entry = asEntry(compose('collect', { entry: [], exit: ['scalar'], stages: [collector], ending: source }));
  const running = run(entry, {}, host.options);
  if (panics) {
    await expect(running.result).rejects.toBe(failure);
    host.controller.abort(failure);
    expect(host.background).toHaveLength(0);
  } else {
    const answer = await running.result;
    expect(answer).toEqual({ scalar: 'first' });
    await draining.promise;
    host.controller.abort();
    running.discard(answer);
    drain.resolve();
    await host.settle();
  }
  expect(host.errors).toEqual([]);
});

it.each([false, true])('runs hosted-tool rounds through the producer scope (panic=%s)', async panics => {
  type Request = { round: number };
  type Response = { events: ManagedStream<number, never> };
  const { defineStage, compose } = factSpace<Request, Response>();
  const rounds: number[] = [];
  const failure = new Error('second-round execute panic');
  const host = hostFor({});
  const terminal = defineStage({
    name: 'model',
    request: { needs: ['round'] },
    return: { provides: ['events'] },
    execute: async ({ round }, scope) => {
      rounds.push(round);
      if (panics && round === 2) throw failure;
      return { events: scope.createStream(async function* () { yield { ok: true, value: round }; }) };
    },
  });
  const tools = defineStage({
    name: 'hosted-tools',
    through: {
      request: { ...emptySide, needs: ['round'], provides: ['round'] },
      response: { ...emptySide, needs: ['events'], provides: ['events'] },
    },
    execute: async (facts, scope) => {
      const first = await scope.next(facts);
      return {
        ...first,
        events: scope.wrapStream(first.events, async function* (source, producer) {
          yield* producer.read(source);
          for (const round of [2, 3]) {
            const further = await producer.next({ ...facts, round });
            yield* producer.read(further.events);
            producer.discard(further);
          }
        }),
      };
    },
  });
  const entry = asEntry(compose('chat', { entry: ['round'], exit: ['events'], stages: [tools], ending: terminal }));
  const running = run(entry, { round: 1 }, host.options);
  const answer = await running.result;
  const reader = running.read(answer.events);
  await expect(reader.next()).resolves.toEqual({ done: false, value: { ok: true, value: 1 } });
  if (panics) {
    await expect(reader.next()).rejects.toBe(failure);
    expect(rounds).toEqual([1, 2]);
  } else {
    const events: Result<number, never>[] = [];
    for await (const event of reader) events.push(event);
    expect(events).toEqual([{ ok: true, value: 2 }, { ok: true, value: 3 }]);
    expect(rounds).toEqual([1, 2, 3]);
  }
  host.controller.abort();
  running.discard(answer);
  await host.settle();
  expect(host.errors).toEqual([]);
});

it('aborts a 401 attempt and discards its HTTP body before retrying with a refreshed credential', async () => {
  type Request = { authorization: string };
  type Response = { status: number; body: ManagedStream<string, string> };
  const { defineStage, compose } = factSpace<Request, Response>();
  const steps: string[] = [];
  const host = hostFor({});
  const dial = defineStage({
    name: 'http-terminal',
    request: { needs: ['authorization'] },
    return: { provides: ['status', 'body?'] },
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
  const retry = defineStage({
    name: 'refresh-credential',
    through: {
      request: { ...emptySide, needs: ['authorization'], provides: ['authorization'] },
      response: { ...emptySide, needs: ['status'] },
    },
    execute: async (facts, scope) => {
      const call = scope.next(facts);
      const answer = await call;
      if (answer.status !== 401) return answer;
      scope.abort(call);
      scope.discard(answer);
      expect(host.background).toHaveLength(1);
      return await scope.next({ ...facts, authorization: 'fresh' });
    },
  });
  const entry = asEntry(compose('claude-code', {
    entry: ['authorization'], exit: ['status', 'body?'], stages: [retry], ending: dial,
  }));
  const running = run(entry, { authorization: 'expired' }, host.options);
  const answer = await running.result;
  expect(answer.status).toBe(200);
  host.controller.abort();
  running.discard(answer);
  await host.settle();
  expect(steps).toEqual(['dial:expired', 'abort', 'dial:fresh', 'drain']);
  expect(host.errors).toEqual([]);
});

it('delivers an encoded guard error before aborting still-active upstream I/O', async () => {
  type Response = { events: ManagedStream<string, string>; body: ManagedStream<string, never> };
  const { defineStage, compose } = factSpace<object, Response>();
  const host = hostFor({});
  const waitingForAbort = Promise.withResolvers<void>();
  const upstreamCancellation = new Error('delivery finished');
  const finished: unknown[] = [];
  const origin = defineStage({
    name: 'origin',
    request: { needs: [] },
    return: { provides: ['events'] },
    execute: async (_facts, scope) => ({
      events: scope.createStream(async function* ({ signal }) {
        yield { ok: true, value: 'malformed' };
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
  const guard = defineStage({
    name: 'guard',
    through: { request: emptySide, response: { ...emptySide, needs: ['events'], provides: ['events'] } },
    execute: async (facts, scope) => {
      const answer = await scope.next(facts);
      return {
        ...answer,
        events: scope.wrapStream(answer.events, async function* (source, producer) {
          for await (const event of producer.read(source)) {
            if (event.ok && event.value === 'malformed') {
              yield { ok: false, error: 'invalid event' };
              producer.discard(source);
              return;
            }
            yield event;
          }
        }),
      };
    },
  });
  const encoder = defineStage({
    name: 'encoder',
    through: { request: emptySide, response: { needs: ['events'], provides: ['body'], consumes: ['events'] } },
    execute: async (facts, scope) => {
      const { events, ...rest } = await scope.next(facts);
      return {
        ...rest,
        body: scope.wrapStream(events, async function* (source, producer) {
          for await (const event of producer.read(source)) {
            if (!event.ok) {
              yield { ok: true, value: JSON.stringify({ error: event.error }) };
              producer.discard(source);
              return;
            }
            yield event;
          }
        }),
      };
    },
  });
  const entry = asEntry(compose('encode', { entry: [], exit: ['body'], stages: [encoder, guard], ending: origin }));
  const running = run(entry, {}, host.options);
  const answer = await running.result;
  const reader = running.read(answer.body);
  await expect(reader.next()).resolves.toEqual({ done: false, value: { ok: true, value: '{"error":"invalid event"}' } });
  await expect(reader.next()).resolves.toEqual({ done: true, value: undefined });
  await waitingForAbort.promise;
  expect(finished).toEqual([]);
  expect(host.background).toHaveLength(2);
  host.controller.abort(upstreamCancellation);
  running.discard(answer);
  await host.settle();
  expect(finished).toEqual([upstreamCancellation]);
  expect(host.errors).toEqual([]);
});

it('reports an original discarded stream panic through waitUntil after business delivery', async () => {
  type Response = { source: ManagedStream<string, never>; answer: string };
  const { defineStage, compose } = factSpace<object, Response>();
  const host = hostFor({});
  const draining = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const failure = new Error('background source failure', { cause: new Error('original cause') });
  const origin = defineStage({
    name: 'origin',
    request: { needs: [] },
    return: { provides: ['source'] },
    execute: async (_facts, scope) => ({
      source: scope.createStream(async function* () {
        yield { ok: true, value: 'discarded' };
        draining.resolve();
        await release.promise;
        throw failure;
      }),
    }),
  });
  const decide = defineStage({
    name: 'decide',
    through: { request: emptySide, response: { needs: ['source'], provides: ['answer'], consumes: ['source'] } },
    execute: async (facts, scope) => {
      const back = await scope.next(facts);
      const { source: _, ...rest } = back;
      scope.discard(back);
      return { ...rest, answer: 'delivered' };
    },
  });
  const entry = asEntry(compose('decide', { entry: [], exit: ['answer'], stages: [decide], ending: origin }));
  const running = run(entry, {}, host.options);
  const back = await running.result;
  expect(back).toEqual({ answer: 'delivered' });
  await draining.promise;
  expect(host.errors).toEqual([]);
  host.controller.abort();
  running.discard(back);
  release.resolve();
  await host.settle();
  expect(host.errors).toEqual([failure]);
  expect(host.errors[0]).toBe(failure);
});

it('starts detached persistence immediately with its own scope and reports its original rejection', async () => {
  type Services = { persist: () => Promise<void> };
  const { defineStage, compose } = factSpace<object, { answer: number }, Services>();
  const failure = new Error('persistence failed');
  const persist = Promise.withResolvers<void>();
  const host = hostFor<Services>({ persist: () => persist.promise });
  const steps: string[] = [];
  const provider = defineStage({
    name: 'provider',
    request: { needs: [] },
    return: { provides: ['answer'] },
    execute: async (_facts, scope) => {
      const services = scope.services;
      scope.detach(async worker => {
        expect(Object.keys(worker).sort()).toEqual(['log', 'services']);
        expect(worker.services).toBe(services);
        expect(worker.log.withField).toBeTypeOf('function');
        steps.push('persist');
        await worker.services.persist();
      });
      steps.push('answer');
      return { answer: 42 };
    },
  });
  const entry = asEntry(compose('provider', { entry: [], exit: ['answer'], stages: [], ending: provider }));
  const running = run(entry, {}, host.options);
  const answer = await running.result;
  expect(answer).toEqual({ answer: 42 });
  expect(steps).toEqual(['persist', 'answer']);
  expect(host.background).toHaveLength(1);
  expect(host.errors).toEqual([]);
  expect(Object.keys(running).sort()).toEqual(['discard', 'read', 'result']);
  host.controller.abort();
  running.discard(answer);
  persist.reject(failure);
  await host.settle();
  expect(host.errors[0]).toBe(failure);
});

it('shares the original live service instance with execute and detached work', async () => {
  class Counter {
    #value = 0;

    increment(): number { return ++this.#value; }
  }

  const service = new Counter();
  const { defineStage, compose } = factSpace<object, { value: number }, Counter>();
  const host = hostFor(service);
  const values: number[] = [];
  const terminal = defineStage({
    name: 'counter', request: { needs: [] }, return: { provides: ['value'] },
    execute: async (_facts, scope) => {
      expect(scope.services).toBe(service);
      values.push(scope.services.increment());
      scope.detach(async worker => {
        expect(worker.services).toBe(service);
        values.push(worker.services.increment());
      });
      return { value: scope.services.increment() };
    },
  });
  const entry = asEntry(compose('counter', { entry: [], exit: ['value'], stages: [], ending: terminal }));
  const running = run(entry, {}, host.options);
  const answer = await running.result;
  expect(answer).toEqual({ value: 3 });
  expect(values).toEqual([1, 2]);
  host.controller.abort();
  running.discard(answer);
  await host.settle();
  expect(host.errors).toEqual([]);
});

it('hands on fresh wrapper handles and reads each source from its producer scope', async () => {
  type Response = { stream: ManagedStream<number, never>; metadata: Deferred<{ count: number }> };
  const { defineStage, compose } = factSpace<object, Response>();
  const host = hostFor({});
  const factories: string[] = [];
  const terminal = defineStage({
    name: 'terminal',
    request: { needs: [] },
    return: { provides: ['stream', 'metadata'] },
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
  const wrapper = defineStage({
    name: 'wrapper',
    through: {
      request: emptySide,
      response: { ...emptySide, needs: ['stream', 'metadata'], provides: ['stream', 'metadata'] },
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
        const [left, right] = await Promise.all([shared.then(value => value.count), shared.then(value => value.count)]);
        return { count: left + right };
      });
      expect(stream).not.toBe(back.stream);
      expect(metadata).not.toBe(back.metadata);
      return { ...back, stream, metadata };
    },
  });
  const entry = asEntry(compose('wrap', { entry: [], exit: ['stream', 'metadata'], stages: [wrapper], ending: terminal }));
  const running = run(entry, {}, host.options);
  const answer = await running.result;
  expect(factories).toEqual(['create stream', 'create deferred', 'wrap stream', 'wrap deferred']);
  await expect(running.read(answer.metadata)).resolves.toEqual({ count: 10 });
  const reader = running.read(answer.stream);
  await expect(reader.next()).resolves.toEqual({ done: false, value: { ok: true, value: 6 } });
  await expect(reader.next()).resolves.toEqual({ done: true, value: undefined });
  host.controller.abort();
  running.discard(answer);
  expect(host.background).toHaveLength(0);
});

it('drains orphaned wrapped and late child resources while preserving the original execute panic', async () => {
  type Request = { attempt: number };
  type Response = { stream: ManagedStream<string, never>; metadata: Deferred<number> };
  const { defineStage, compose } = factSpace<Request, Response>();
  const host = hostFor({});
  const late = Promise.withResolvers<void>();
  const usage = Promise.withResolvers<number>();
  const events: string[] = [];
  const failure = new Error('execute failed while holding resources');
  const terminal = defineStage({
    name: 'child',
    request: { needs: ['attempt'] },
    return: { provides: ['stream', 'metadata?'] },
    execute: async ({ attempt }, scope) => {
      events.push(`call:${attempt}`);
      if (attempt === 2) await late.promise;
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
  const stage = defineStage({
    name: 'abandon',
    through: {
      request: { ...emptySide, needs: ['attempt'], provides: ['attempt'] },
      response: { ...emptySide, needs: ['stream'] },
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
      throw failure;
    },
  });
  const entry = asEntry(compose('orphan', {
    entry: ['attempt'], exit: ['stream', 'metadata?'], stages: [stage], ending: terminal,
  }));
  const running = run(entry, { attempt: 1 }, host.options);
  await expect(running.result).rejects.toBe(failure);
  expect(events).toContain('call:2');
  expect(events).not.toContain('stream:2');
  expect(host.background).toHaveLength(3);
  host.controller.abort(failure);
  late.resolve();
  usage.resolve(2);
  await host.settle();
  expect(events).toEqual(expect.arrayContaining(['stream:1', 'wrapped stream', 'stream:2', 'late metadata']));
  expect(host.background).toHaveLength(5);
  expect(host.errors).toEqual([]);
});

it('preserves queued stream reads and an opened deferred after whole-answer discard', async () => {
  type Response = { stream: ManagedStream<number, never>; usage: Deferred<number> };
  const { defineStage, compose } = factSpace<object, Response>();
  const host = hostFor({});
  const firstStarted = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const deferred = Promise.withResolvers<number>();
  const reads: string[] = [];
  const terminal = defineStage({
    name: 'queue',
    request: { needs: [] },
    return: { provides: ['stream', 'usage'] },
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
  const entry = asEntry(compose('queue', {
    entry: [], exit: ['stream', 'usage'], stages: [], ending: terminal,
  }));
  const running = run(entry, {}, host.options);
  const answer = await running.result;
  host.controller.abort('interrupted');
  const reader = running.read(answer.stream);
  const first = reader.next();
  const second = reader.next();
  const usage = running.read(answer.usage);
  await firstStarted.promise;
  expect(reads).toEqual(['first entered']);
  running.discard(answer);
  await expect(reader.next()).rejects.toThrow('without custody');
  expect(() => running.read(answer.usage)).toThrow('without custody');
  expect(host.background).toHaveLength(1);
  releaseFirst.resolve();
  deferred.resolve(6);
  await expect(first).resolves.toEqual({ done: false, value: { ok: true, value: 1 } });
  await expect(second).resolves.toEqual({ done: false, value: { ok: true, value: 2 } });
  await expect(usage).resolves.toBe(6);
  await host.settle();
  expect(reads).toEqual(['first entered', 'second entered', 'drain entered', 'native done']);
  expect(host.errors).toEqual([]);
  running.discard(answer);
  expect(host.background).toHaveLength(1);
});

it('propagates parent cancellation natively to active and previously settled child signals', async () => {
  type Role = 'finished' | 'first' | 'second';
  type Request = { role: Role };
  type Response = { result: true; work: Deferred<void> };
  const { defineStage, compose } = factSpace<Request, Response>();
  const host = hostFor({});
  const signals = new Map<Role, AbortSignal>();
  const active = new Set<Role>();
  const interrupted: Role[] = [];
  const reason = new Error('client disconnected');
  const terminal = defineStage({
    name: 'bind-io',
    request: { needs: ['role'] },
    return: { provides: ['result', 'work?'] },
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
  const fanout = defineStage({
    name: 'fanout',
    through: {
      request: { ...emptySide, needs: ['role'], provides: ['role'] },
      response: { ...emptySide, needs: ['result', 'work?'], consumes: ['work'] },
    },
    return: { provides: ['result'] },
    execute: async (facts, scope) => {
      const finishedCall = scope.next(facts);
      const finished = await finishedCall;
      scope.abort(finishedCall);
      scope.abort(finishedCall);
      expect(signals.get('finished')?.aborted).toBe(false);
      expect(active.has('finished')).toBe(false);
      scope.discard(finished);
      const first = scope.next({ ...facts, role: 'first' });
      const second = scope.next({ ...facts, role: 'second' });
      expect(first).not.toBe(second);
      expect(() => scope.abort(first.then(value => value))).toThrow('original promise');
      scope.discard(await first);
      scope.discard(await second);
      return { result: true };
    },
  });
  const entry = asEntry(compose('fanout', { entry: ['role'], exit: ['result'], stages: [fanout], ending: terminal }));
  const running = run(entry, { role: 'finished' }, host.options);
  const answer = await running.result;
  expect(active).toEqual(new Set(['first', 'second']));
  expect(signals.get('finished')?.aborted).toBe(false);
  host.controller.abort(reason);
  expect(interrupted.toSorted()).toEqual(['first', 'second']);
  expect(signals.get('finished')?.aborted).toBe(true);
  expect(signals.get('finished')?.reason).toBe(reason);
  running.discard(answer);
  await host.settle();
  expect(active.size).toBe(0);
  expect(host.errors).toEqual([]);
});

it('starts an independent sub-request under the initiating stage and accepts its original promise for abort', async () => {
  const { defineStage, compose } = factSpace<{ query: string }, {
    tool: ManagedStream<string, string>;
    reply: string;
  }>();
  const host = hostFor({});
  const childSignals: AbortSignal[] = [];
  const toolStage = defineStage({
    name: 'search',
    request: { needs: ['query'] },
    return: { provides: ['tool'] },
    execute: async ({ query }, scope) => ({
      tool: scope.createStream(async function* (producer) {
        childSignals.push(producer.signal);
        yield { ok: true, value: query };
        if (producer.signal.aborted) yield { ok: false, error: 'closed' };
      }),
    }),
  });
  const tool = asEntry(compose('search', { entry: ['query'], exit: ['tool'], stages: [], ending: toolStage }));
  const hostStage = defineStage({
    name: 'tool-initiator',
    request: { needs: ['query'] },
    return: { provides: ['reply'] },
    execute: async (facts, scope) => {
      const call = scope.run(tool, facts);
      const back = await call;
      const stream = scope.read(back.tool);
      const first = await stream.next();
      if (first.done || !first.value.ok) throw new Error('Expected the search result');
      scope.abort(call);
      scope.discard(back);
      expect(scope.signal.aborted).toBe(false);
      return { reply: first.value.value };
    },
  });
  const entry = asEntry(compose('chat', { entry: ['query'], exit: ['reply'], stages: [], ending: hostStage }));
  const running = run(entry, { query: 'question' }, host.options);
  const answer = await running.result;
  expect(answer).toEqual({ reply: 'question' });
  expect(childSignals[0]?.aborted).toBe(true);
  expect(host.controller.signal.aborted).toBe(false);
  host.controller.abort();
  running.discard(answer);
  await host.settle();
  expect(host.errors).toEqual([]);
});

it('keeps a child abortable while its borrowed stream lives without changing the producing signal', async () => {
  type Borrowed = { body?: ManagedStream<string, never>; metadata?: Deferred<number> };
  type Request = { borrowed: Borrowed };
  type Response = Borrowed & { result: true };
  const { defineStage, compose } = factSpace<Request, Response>();
  const host = hostFor({});
  const receivingSignals: AbortSignal[] = [];
  const producingSignals: AbortSignal[] = [];
  const relay = defineStage({
    name: 'borrowed-answer', request: { needs: ['borrowed'] }, return: { provides: ['body?', 'metadata?'] },
    execute: async ({ borrowed }, scope) => {
      receivingSignals.push(scope.signal);
      return borrowed;
    },
  });
  const stage = defineStage({
    name: 'lender',
    through: {
      request: { ...emptySide, provides: ['borrowed'] },
      response: { needs: ['body?', 'metadata?'], consumes: ['body', 'metadata'], provides: ['result'] },
    },
    execute: async (facts, scope) => {
      for (const abortBeforeDone of [true, false]) {
        const body = scope.createStream(producer => {
          producingSignals.push(producer.signal);
          return (async function* () { yield { ok: true, value: 'borrowed' } as const; })();
        });
        const call = scope.next({ ...facts, borrowed: { body } });
        const answer = await call;
        const received = receivingSignals.at(-1)!;
        const produced = producingSignals.at(-1)!;
        expect(answer.body).toBe(body);
        expect(received).not.toBe(produced);
        expect(received.aborted).toBe(false);
        if (abortBeforeDone) {
          scope.abort(call);
          expect(received.aborted).toBe(true);
          expect(produced.aborted).toBe(false);
        }
        const reader = scope.read(body);
        await expect(reader.next()).resolves.toEqual({ done: false, value: { ok: true, value: 'borrowed' } });
        expect((await reader.next()).done).toBe(true);
        scope.abort(call);
        expect(received.aborted).toBe(abortBeforeDone);
        expect(produced.aborted).toBe(false);
        scope.discard(answer);
      }
      const metadata = scope.createDeferred(async () => 1);
      const call = scope.next({ ...facts, borrowed: { metadata } });
      const answer = await call;
      expect(answer.metadata).toBe(metadata);
      scope.abort(call);
      expect(receivingSignals.at(-1)?.aborted).toBe(false);
      scope.discard(answer);
      return { result: true };
    },
  });
  const entry = asEntry(compose('borrowed', { entry: [], exit: ['result'], stages: [stage], ending: relay }));
  const running = run(entry, {}, host.options);
  const answer = await running.result;
  expect(answer).toEqual({ result: true });
  expect(producingSignals.every(signal => !signal.aborted)).toBe(true);
  host.controller.abort();
  running.discard(answer);
  await host.settle();
  expect(host.errors).toEqual([]);
});

it('keeps a child abortable through a submitted discard drain and reports its exact rejection', async () => {
  type Request = { body: ManagedStream<string, never> };
  type Response = { delivered: number };
  const { defineStage, compose } = factSpace<Request, Response>();
  const host = hostFor({});
  const draining = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const failure = new Error('borrowed drain failed');
  const signals: AbortSignal[] = [];
  const discard = defineStage({
    name: 'discard-body', request: { needs: ['body'] }, return: { provides: ['delivered'] },
    execute: async ({ body }, scope) => {
      signals.push(scope.signal);
      scope.discard(body);
      return { delivered: 1 };
    },
  });
  const stage = defineStage({
    name: 'call-with-body',
    through: {
      request: { ...emptySide, provides: ['body'] },
      response: { ...emptySide, needs: ['delivered'] },
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
  const entry = asEntry(compose('discard-borrowed', { entry: [], exit: ['delivered'], stages: [stage], ending: discard }));
  const running = run(entry, {}, host.options);
  const answer = await running.result;
  expect(answer).toEqual({ delivered: 1 });
  expect(host.errors).toEqual([]);
  host.controller.abort();
  running.discard(answer);
  finish.resolve();
  await host.settle();
  expect(host.errors[0]).toBe(failure);
});
