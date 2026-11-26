import { inspect } from 'node:util';

import { expect, it } from 'vitest';

import { emptySide, hostFor } from './run-fixture.ts';
import { asEntry, factSpace, run, secret } from '../src/index.ts';
import type { Deferred, ManagedStream, Secret } from '../src/index.ts';
import { revealSecret } from '../src/transport.ts';

it('freezes handoffs, stream frames and deferred values while preserving shared references', async () => {
  const bytes = new Uint8Array([5]);
  const node = { value: { count: 1 }, bytes };
  const shared = Object.freeze({ node });
  const marked = secret({ shared });
  const frame = { shared };
  const deferred = { shared };
  type Request = { marked: Secret<{ shared: typeof shared }>; shared: typeof shared };
  type Response = {
    shared: typeof shared;
    body: ManagedStream<typeof frame, never>;
    metadata: Deferred<typeof deferred>;
  };
  const { defineStage, compose } = factSpace<Request, Response>();
  const host = hostFor({});
  const terminal = defineStage({
    name: 'immutable-values', request: { needs: ['marked', 'shared'] }, return: { provides: ['shared', 'body', 'metadata'] },
    execute: async (facts, scope) => {
      expect(Object.isFrozen(facts)).toBe(true);
      expect(Object.isFrozen(revealSecret(facts.marked))).toBe(true);
      expect(Object.isFrozen(facts.shared.node.value)).toBe(true);
      expect(facts.shared).toBe(shared);
      expect(facts.shared.node.bytes).toBe(bytes);
      expect(Object.isFrozen(bytes)).toBe(false);
      return {
        shared: facts.shared,
        body: scope.createStream(async function* () { yield { ok: true, value: frame }; }),
        metadata: scope.createDeferred(async () => deferred),
      };
    },
  });
  const entry = asEntry(compose('freeze', {
    entry: ['marked', 'shared'], exit: ['shared', 'body', 'metadata'], stages: [], ending: terminal,
  }));
  const running = run(entry, { marked, shared }, host.options);
  const answer = await running.result;
  expect(answer.shared).toBe(shared);
  expect(Object.isFrozen(answer)).toBe(true);
  const reader = running.read(answer.body);
  const reading = await reader.next();
  expect(reading.value).toEqual({ ok: true, value: frame });
  expect(Object.isFrozen(reading.value)).toBe(true);
  expect(Object.isFrozen(frame)).toBe(true);
  expect((await reader.next()).done).toBe(true);
  await expect(running.read(answer.metadata)).resolves.toBe(deferred);
  expect(Object.isFrozen(deferred)).toBe(true);
  host.controller.abort();
  running.discard(answer);
});

it('preserves Secret marking through map and exposes plaintext only at transport', () => {
  const value = secret('private credential');
  const derived = value.map(credential => ({ header: `Bearer ${credential}` }));
  expect(Object.keys(value)).toEqual([]);
  expect(Object.keys(derived)).toEqual([]);
  expect(JSON.stringify(derived)).toBe('"[secret]"');
  expect(String(derived)).toBe('[secret]');
  expect(inspect(derived)).toBe('[secret]');
  expect(revealSecret(derived)).toEqual({ header: 'Bearer private credential' });
  expect(revealSecret(secret(undefined))).toBeUndefined();
});

it('panics on a yield after Err and unwinds the producer without resuming ordinary work', async () => {
  type Response = { body: ManagedStream<number, string> };
  const { defineStage, compose } = factSpace<object, Response>();
  const host = hostFor({});
  const execution: string[] = [];
  const terminal = defineStage({
    name: 'invalid-sequence', request: { needs: [] }, return: { provides: ['body'] },
    execute: async (_facts, scope) => ({
      body: scope.createStream<number, string>(async function* () {
        try {
          yield { ok: false, error: 'expected failure' };
          yield { ok: true, value: 1 };
          execution.push('ordinary work');
        } finally {
          execution.push('finally entry');
          yield { ok: true, value: 2 };
          execution.push('finally exit');
        }
      }),
    }),
  });
  const entry = asEntry(compose('invalid-sequence', { entry: [], exit: ['body'], stages: [], ending: terminal }));
  const running = run(entry, {}, host.options);
  const answer = await running.result;
  const reader = running.read(answer.body);
  await expect(reader.next()).resolves.toEqual({ done: false, value: { ok: false, error: 'expected failure' } });
  await expect(reader.next()).rejects.toThrow('yielded after Err');
  host.controller.abort();
  running.discard(answer);
  await host.settle();
  expect(execution).toEqual(['finally entry', 'finally exit']);
  expect(host.errors).toEqual([]);
});

it('preserves a frame validation panic for the reader and reports an independent finalizer panic', async () => {
  type Response = { body: ManagedStream<object, never> };
  const { defineStage, compose } = factSpace<object, Response>();
  const host = hostFor({});
  const validation = new Error('frame traversal failed');
  const finalizer = new Error('finalizer failed');
  const payload = new Proxy({}, { ownKeys: () => { throw validation; } });
  const visited: string[] = [];
  const terminal = defineStage({
    name: 'invalid-frame', request: { needs: [] }, return: { provides: ['body'] },
    execute: async (_facts, scope) => ({
      body: scope.createStream(async function* (producer) {
        producer.createDeferred(async () => { visited.push('orphan produced'); return 1; });
        try {
          yield { ok: true, value: payload };
          visited.push('ordinary work');
        } finally {
          visited.push('finally before suspended yield');
          yield { ok: true, value: {} };
          visited.push('finally after suspended yield');
          throw finalizer;
        }
      }),
    }),
  });
  const entry = asEntry(compose('invalid-frame', { entry: [], exit: ['body'], stages: [], ending: terminal }));
  const running = run(entry, {}, host.options);
  const answer = await running.result;
  await expect(running.read(answer.body).next()).rejects.toBe(validation);
  host.controller.abort(validation);
  running.discard(answer);
  await host.settle();
  expect(visited).toEqual(['orphan produced', 'finally before suspended yield', 'finally after suspended yield']);
  expect(host.background).toHaveLength(2);
  expect(host.errors[0]).toBe(finalizer);
});

it('rejects a normally exiting holder that retained an already settled deferred', async () => {
  const { defineStage, compose } = factSpace<object, { answer: number }>();
  const host = hostFor({});
  const terminal = defineStage({
    name: 'leak', request: { needs: [] }, return: { provides: ['answer'] },
    execute: async (_facts, scope) => {
      const completed = Promise.resolve({ value: 1 });
      scope.createDeferred(() => completed);
      const value = await completed;
      expect(Object.isFrozen(value)).toBe(true);
      return { answer: 42 };
    },
  });
  const entry = asEntry(compose('leak', { entry: [], exit: ['answer'], stages: [], ending: terminal }));
  await expect(run(entry, {}, host.options).result).rejects.toThrow('leaked 1 stream or deferred handle');
  host.controller.abort();
  await host.settle();
  expect(host.background).toHaveLength(1);
  expect(host.errors).toEqual([]);
});

it('rejects early iteration return, then drains the legitimate discarded answer', async () => {
  const { defineStage, compose } = factSpace<object, { body: ManagedStream<number, never> }>();
  const host = hostFor({});
  const visited: number[] = [];
  const terminal = defineStage({
    name: 'iteration', request: { needs: [] }, return: { provides: ['body'] },
    execute: async (_facts, scope) => ({
      body: scope.createStream(async function* () {
        for (const value of [1, 2]) {
          visited.push(value);
          yield { ok: true, value };
        }
      }),
    }),
  });
  const entry = asEntry(compose('iteration', { entry: [], exit: ['body'], stages: [], ending: terminal }));
  const running = run(entry, {}, host.options);
  const answer = await running.result;
  const reader = running.read(answer.body);
  await expect((async () => {
    for await (const item of reader) {
      expect(item).toEqual({ ok: true, value: 1 });
      break;
    }
  })()).rejects.toThrow('left before native done');
  expect(() => running.discard({ ...answer })).toThrow('Expected an answer received by this holder');
  host.controller.abort();
  running.discard(answer);
  await host.settle();
  expect(visited).toEqual([1, 2]);
});

it.each([false, true])('rejects a producer leak or an expired execute scope (expired=%s)', async expired => {
  type Response = { body: ManagedStream<string, never> };
  const { defineStage, compose } = factSpace<object, Response>();
  const host = hostFor({});
  const visited: string[] = [];
  const source = defineStage({
    name: 'source', request: { needs: [] }, return: { provides: ['body'] },
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
  const wrapper = defineStage({
    name: 'wrapper',
    through: { request: emptySide, response: { ...emptySide, needs: ['body'], provides: ['body'] } },
    execute: async (facts, scope) => {
      const back = await scope.next(facts);
      const body = scope.wrapStream(back.body, async function* () {
        if (expired) {
          // The execute scope was deliberately captured to exercise its closed lifetime.
          await scope.next(facts);
        }
        yield { ok: true, value: 'wrapper' } as const;
      });
      return { ...back, body };
    },
  });
  const entry = asEntry(compose('holder-boundary', { entry: [], exit: ['body'], stages: [wrapper], ending: source }));
  const running = run(entry, {}, host.options);
  const answer = await running.result;
  const reader = running.read(answer.body);
  if (expired) {
    await expect(reader.next()).rejects.toThrow('scope has exited');
  } else {
    await expect(reader.next()).resolves.toEqual({ done: false, value: { ok: true, value: 'wrapper' } });
    await expect(reader.next()).rejects.toThrow('leaked 1 stream or deferred handle');
  }
  host.controller.abort();
  running.discard(answer);
  await host.settle();
  expect(visited).toEqual(['source finally']);
  expect(host.errors).toEqual([]);
});

it.each([1, 2])('checks one continuation by handoff and multiple by returned key presence (children=%s)', async children => {
  const { defineStage, compose } = factSpace<object, { value: string }>();
  const host = hostFor({});
  const fixed = { value: 'same shared answer' };
  const terminal = defineStage({
    name: 'constant', request: { needs: [] }, return: { provides: ['value'] },
    execute: async () => fixed,
  });
  const modify = defineStage({
    name: 'modify',
    through: { request: emptySide, response: { ...emptySide, needs: ['value'] } },
    execute: async (facts, scope) => {
      const first = scope.next(facts);
      const answer = await first;
      if (children === 2) {
        const second = scope.next(facts);
        expect(first).not.toBe(second);
        expect(await second).toBe(answer);
      }
      scope.discard(answer);
      return { ...answer, value: 'updated' };
    },
  });
  const entry = asEntry(compose('continuation', { entry: [], exit: ['value'], stages: [modify], ending: terminal }));
  const running = run(entry, {}, host.options);
  if (children === 1) {
    await expect(running.result).rejects.toThrow('changed undeclared "value"');
    host.controller.abort();
    return;
  }
  const result = await running.result;
  expect(result).toEqual({ value: 'updated' });
  host.controller.abort();
  running.discard(result);
});

it.each([
  ['request', 'removed or changed undeclared "hidden"'],
  ['in-place', 'does not match an in-place return'],
  ['single', 'removed or changed undeclared "hidden"'],
  ['multi-new', 'returned facts outside its declarations and child answers'],
  ['multi-existing', undefined],
] as const)('checks non-enumerable own keys on %s handoffs', async (path, failure) => {
  const { defineStage, compose } = factSpace<object, { value: string; hidden: string }>();
  const host = hostFor({});
  const terminal = defineStage({
    name: 'terminal', request: { needs: [] }, return: { provides: ['value', 'hidden?'] },
    execute: async () => Object.defineProperty({ value: 'answer' }, path === 'in-place' ? 'invented' : 'hidden', { value: 'source' }),
  });
  const stage = defineStage({
    name: 'handoff',
    through: { request: emptySide, response: { ...emptySide, needs: ['value'] } },
    execute: async (facts, scope) => {
      const back = await scope.next({ ...facts });
      if (path === 'single') return Object.defineProperty({ ...back }, 'hidden', { value: 'changed' });
      await scope.next(facts);
      return path === 'multi-existing'
        ? { ...back, hidden: 'chosen' }
        : Object.defineProperty({ ...back }, 'invented', { value: 'unknown' });
    },
  });
  const entry = asEntry(compose('handoff', { entry: [], exit: ['value', 'hidden?'], stages: [stage], ending: terminal }));
  const request = path === 'request' ? Object.defineProperty({}, 'hidden', { value: 'request' }) : {};
  const running = run(entry, request, host.options);
  if (failure) {
    await expect(running.result).rejects.toThrow(failure);
    host.controller.abort();
    return;
  }
  const result = await running.result;
  expect(result.hidden).toBe('chosen');
  host.controller.abort();
  running.discard(result);
});

it.each([false, true])('requires public exit keys even after multiple continuations (drop required=%s)', async dropRequired => {
  const { defineStage, compose } = factSpace<object, { value: number; optional: number }>();
  const host = hostFor({});
  const terminal = defineStage({
    name: 'provide', request: { needs: [] }, return: { provides: ['value', 'optional?'] },
    execute: async () => ({ value: 1, optional: 2 }),
  });
  const stage = defineStage({
    name: 'multiple', through: { request: emptySide, response: emptySide },
    execute: async (facts, scope) => {
      await scope.next(facts);
      await scope.next(facts);
      return dropRequired ? {} : { value: 1 };
    },
  });
  const entry = asEntry(compose('public-exit', { entry: [], exit: ['value', 'optional?'], stages: [stage], ending: terminal }));
  const running = run(entry, {}, host.options);
  if (dropRequired) {
    await expect(running.result).rejects.toThrow('Pipeline "public-exit" exit is missing "value"');
    host.controller.abort();
    return;
  }
  const answer = await running.result;
  expect(answer).toEqual({ value: 1 });
  host.controller.abort();
  running.discard(answer);
});
