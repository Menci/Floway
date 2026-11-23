import { describe, expect, it, vi } from 'vitest';

import { compose, DeclarationViolationError, deferredIdOf, defineEnding, defineStage, FinalizationTimeoutError, run, transform, UnsettledDeferredError } from '../src/index.ts';
import type { Deferred, Facts, FactValue, ManagedStream, RunDone, RunEvent, SideDecl, Scope, StreamEnd } from '../src/index.ts';

type TestSpace = {
  branch: FactValue;
  drop?: FactValue;
  response: FactValue;
  preserve: FactValue;
  winner: FactValue;
  work: Deferred<number>;
  constructor: number;
};
const composeTest = compose<TestSpace>();
const options = { services: {}, finalizationTimeoutMs: 200 };
const identity = { needs: [], consumes: [], provides: [] };

const leaf = defineEnding<Facts, Facts>({
  name: 'leaf', request: { needs: ['branch'] }, return: { provides: ['response', 'preserve'] },
  execute: async facts => ({ response: facts.branch, preserve: { branch: facts.branch } }),
});

describe('declarations during execution', () => {
  const examples: Array<[string, SideDecl, (facts: Facts) => Facts, string]> = [
    ['branch stays with undefined', { ...identity, consumes: ['drop'] }, facts => ({ ...facts, drop: undefined }), 'declared consuming "drop"'],
    ['provided key is absent', { ...identity, provides: ['added'] }, facts => facts, 'declared providing "added"'],
    ['undeclared key changes', identity, facts => ({ ...facts, branch: 3 }), 'changed or removed undeclared "branch"'],
    ['undeclared key appears', identity, facts => ({ ...facts, added: 3 }), 'added undeclared "added"'],
  ];

  it.each(examples)('rejects a down handover where %s', async (_title, request, update, message) => {
    const stage = defineStage<Facts, Facts, Facts, Facts>({
      name: 'down', through: { request, response: identity },
      execute: async (facts, scope) => await scope.next(update(facts)),
    });
    const pipeline = composeTest('checks', { entry: ['branch'], optionalEntry: ['drop'], exit: [], stages: [stage], ending: leaf });
    const handle = run(pipeline, { branch: 1, drop: true }, options);
    await expect(handle.result).rejects.toMatchObject({ name: 'DeclarationViolationError', direction: 'down', detail: expect.stringContaining(message) });
    await expect(handle.done).resolves.toMatchObject({ ok: false });
  });

  it.each(examples.map(([title, side, change, message]) => [title, {
    ...side, consumes: side.consumes.map(() => 'response'),
  }, change, message.replace('"drop"', '"response"').replace('"branch"', '"preserve"')] as const))(
    'rejects an up handover where %s', async (_title, response, change, message) => {
      const stage = defineStage<Facts, Facts, Facts, Facts>({
        name: 'up', through: { request: identity, response },
        execute: async (facts, scope) => {
          const back = await scope.next(facts);
          if (response.consumes.length) return { ...back, response: undefined };
          if (message.includes('"preserve"')) return { ...back, preserve: {} };
          return change(back);
        },
      });
      const pipeline = composeTest('checks', { entry: ['branch'], optionalEntry: ['drop'], exit: [], stages: [stage], ending: leaf });
      const handle = run(pipeline, { branch: 1 }, options);
      await expect(handle.result).rejects.toMatchObject({ name: 'DeclarationViolationError', direction: 'up', detail: expect.stringContaining(message) });
    },
  );

  it('uses the earlier winning child as the base and leaves retained keys untouched', async () => {
    const stage = defineStage<Facts, Facts, Facts, Facts>({
      name: 'choose', through: {
        request: { ...identity, provides: ['branch'] },
        response: { ...identity, consumes: ['response'], provides: ['winner'] },
      },
      execute: async (facts, scope) => {
        const first = await scope.next({ ...facts, branch: 1 });
        await scope.next({ ...facts, branch: 2 });
        const { response, ...rest } = first;
        return { ...rest, winner: response };
      },
    });
    const events: RunEvent[] = [];
    const pipeline = composeTest('fork', { entry: [], exit: ['winner'], stages: [stage], ending: leaf });
    const handle = run(pipeline, {}, { ...options, events: event => events.push(event) });
    const output = await handle.result;
    await expect(handle.done).resolves.toEqual({ ok: true });
    const children = events.filter(event => event.k === 'enter' && event.edge === 'next');
    expect(children).toHaveLength(2);
    expect(events).toContainEqual(expect.objectContaining({ k: 'leave', stageId: 1, facts: output, baseChildId: 2 }));
    expect(output).toEqual({ preserve: { branch: 1 }, winner: 1 });
  });

  it('accepts a declared synthetic response and counts present undefined for needs and provides', async () => {
    const stage = defineStage<Facts, Facts, Facts, Facts>({
      name: 'stub',
      through: { request: identity, response: identity },
      return: { provides: ['response'] },
      execute: async () => ({ response: undefined }),
    });
    const pipeline = composeTest('synthetic', { entry: ['branch'], exit: ['response'], stages: [stage], ending: leaf });
    await expect(run(pipeline, { branch: undefined }, options).result).resolves.toStrictEqual({ response: undefined });
    // @ts-expect-error The required entry key is absent at runtime.
    await expect(run(pipeline, {}, options).result).rejects.toThrow(DeclarationViolationError);

    const missing = defineStage({
      name: 'missing', return: { provides: ['response'] }, execute: async () => ({}),
    });
    await expect(run(composeTest('missing', { entry: ['branch'], exit: ['response'], stages: [missing], ending: leaf }), { branch: 1 }, options).result).rejects.toThrow('missing "response"');

    const absent = defineStage({
      name: 'absent', through: { request: identity, response: identity }, execute: async () => ({}),
    });
    await expect(run(composeTest('absent', { entry: ['branch'], exit: [], stages: [absent], ending: leaf }), { branch: 1 }, options).result).rejects.toThrow('without a child response');

    const invalid = defineStage<Facts, Facts, Facts, Facts>({
      name: 'late stub', through: { request: identity, response: identity }, return: { provides: ['response'] },
      execute: async (facts, scope) => {
        await scope.next(facts);
        return { response: undefined };
      },
    });
    await expect(run(composeTest('invalid', { entry: ['branch'], exit: ['response'], stages: [invalid], ending: leaf }), { branch: undefined }, options).result).rejects.toThrow('removed undeclared "preserve"');
  });

  describe('rejected children', () => {
    const failure = new Error('child panic');
    const through = { request: { ...identity, provides: ['branch'] }, response: identity };
    const ending = defineEnding<Facts, Facts>({
      name: 'child', request: { needs: ['branch'] }, return: { provides: ['response'] },
      execute: async facts => {
        if (facts.branch !== 'answered') throw failure;
        return { response: 'answered' };
      },
    });

    it.each([true, false])('checks return after all children reject (declared: %s)', async declared => {
      const stage = defineStage<Facts, Facts, Facts, Facts>({
        name: 'parent', through, ...(declared ? { return: { provides: ['response'] } } : {}),
        execute: async (facts, scope) => {
          await expect(scope.next({ ...facts, branch: 'first' })).rejects.toBe(failure);
          await expect(scope.next({ ...facts, branch: 'second' })).rejects.toBe(failure);
          return { response: 'unavailable' };
        },
      });
      const events: RunEvent[] = [];
      const handle = run(composeTest('all failed', { entry: [], exit: ['response'], stages: [stage], ending }), {}, { ...options, events: event => events.push(event) });
      await expect(handle.result).rejects.toMatchObject({
        name: 'DeclarationViolationError', direction: 'up', detail: 'response matches no child',
      });
      await expect(handle.done).resolves.toMatchObject({ ok: false });
      expect(events.filter(event => event.k === 'closed' && !event.ok && event.stageId !== 1)).toEqual([
        expect.objectContaining({ stageId: 2, error: expect.objectContaining({ message: failure.message }) }),
        expect.objectContaining({ stageId: 3, error: expect.objectContaining({ message: failure.message }) }),
      ]);
    });

    it.each([true, false])('requires an answered child as the base (uses its facts: %s)', async usesBase => {
      const stage = defineStage<Facts, Facts, Facts, Facts>({
        name: 'parent', through, return: { provides: ['response'] },
        execute: async (facts, scope) => {
          await expect(scope.next({ ...facts, branch: 'failed' })).rejects.toBe(failure);
          const answered = await scope.next({ ...facts, branch: 'answered' });
          return usesBase ? answered : { response: 'synthetic' };
        },
      });
      const events: RunEvent[] = [];
      const handle = run(composeTest('mixed', { entry: [], exit: ['response'], stages: [stage], ending }), {}, { ...options, events: event => events.push(event) });
      if (!usesBase) {
        await expect(handle.result).rejects.toMatchObject({
          name: 'DeclarationViolationError', direction: 'up', detail: 'changed or removed undeclared "response"',
        });
        return;
      }
      await expect(handle.result).resolves.toEqual({ response: 'answered' });
      await expect(handle.done).resolves.toMatchObject({ ok: false, error: { message: failure.message } });
      expect(events).toContainEqual(expect.objectContaining({ k: 'leave', stageId: 1, baseChildId: 3 }));
    });

    it('requires a base while a child still has a pending response', async () => {
      const release = Promise.withResolvers<void>();
      const pending = defineEnding<Facts, Facts>({
        name: 'pending', request: { needs: [] }, return: { provides: ['response'] },
        execute: async () => {
          await release.promise;
          return { response: 'late' };
        },
      });
      const stage = defineStage<Facts, Facts, Facts, Facts>({
        name: 'parent', through, return: { provides: ['response'] },
        execute: async (facts, scope) => {
          void scope.next({ ...facts, branch: 'pending' });
          return { response: 'synthetic' };
        },
      });
      const handle = run(composeTest('pending', { entry: [], exit: ['response'], stages: [stage], ending: pending }), {}, options);
      try {
        await expect(handle.result).rejects.toThrow('response matches no child');
      } finally {
        release.resolve();
        await handle.done;
      }
    });
  });

  it('uses own keys and Object.is at each handover', async () => {
    const pass = defineStage<Facts, Facts, Facts, Facts>({
      name: 'pass', through: { request: identity, response: identity },
      execute: async (facts, scope) => await scope.next({ ...facts }),
    });
    const p = composeTest('NaN', { entry: ['branch'], exit: ['response'], stages: [pass], ending: leaf });
    await expect(run(p, { branch: NaN }, options).result).resolves.toMatchObject({ response: NaN });
    const negZero = defineStage<Facts, Facts, Facts, Facts>({
      name: 'negative zero', through: { request: identity, response: identity },
      execute: async (facts, scope) => await scope.next({ ...facts, branch: -0 }),
    });
    await expect(run(composeTest('zero', { entry: ['branch'], exit: ['response'], stages: [negZero], ending: leaf }), { branch: +0 }, options).result).rejects.toThrow('changed or removed undeclared "branch"');

    const needsOwn = defineEnding<Facts, Facts>({
      name: 'own', request: { needs: ['constructor'] }, return: { provides: [] }, execute: async () => ({}),
    });
    // @ts-expect-error The inherited constructor does not satisfy the required fact.
    await expect(run(composeTest('own', { entry: ['constructor'], exit: [], stages: [], ending: needsOwn }), {}, options).result).rejects.toThrow('missing "constructor"');
  });

  it('prefers response identity, then the earliest-called qualifying child', async () => {
    for (const useIdentity of [true, false]) {
      const release = Promise.withResolvers<void>();
      const events: RunEvent[] = [];
      const stage = defineStage<Facts, Facts, Facts, Facts>({
        name: 'choose', through: { request: { ...identity, provides: ['branch'] }, response: identity },
        execute: async (facts, scope) => {
          const first = scope.next({ ...facts, branch: 1 });
          const second = await scope.next({ ...facts, branch: 2 });
          release.resolve();
          await first;
          return useIdentity ? second : { ...second };
        },
      });
      const end = defineEnding<Facts, Facts>({
        name: 'fork', request: { needs: ['branch'] }, return: { provides: ['response'] },
        execute: async facts => {
          if (facts.branch === 1) await release.promise;
          return { response: 'same' };
        },
      });
      const pipeline = composeTest('choose', { entry: [], exit: ['response'], stages: [stage], ending: end });
      await expect(run(pipeline, {}, { ...options, events: event => events.push(event) }).result).resolves.toEqual({ response: 'same' });
      expect(events).toContainEqual(expect.objectContaining({ k: 'leave', stageId: 1, baseChildId: useIdentity ? 3 : 2 }));
    }
  });

  it('runs transform open per invocation and passes through an omitted side by identity', async () => {
    const inputs: Facts[] = [];
    const stage = defineStage<Facts, Facts, Facts, Facts>({
      name: 'rewrite', through: { request: identity, response: { ...identity, provides: ['response'] } },
      execute: transform(() => {
        let count = 0;
        return { response: back => ({ ...back, response: ++count }) };
      }),
    });
    const terminal = defineEnding<Facts, Facts>({
      name: 'identity', request: { needs: [] }, return: { provides: [] },
      execute: async facts => { inputs.push(facts); return facts; },
    });
    const pipeline = composeTest('rewrite', { entry: ['branch'], exit: ['response'], stages: [stage], ending: terminal });
    const input = { branch: 1 };
    await expect(run(pipeline, input, options).result).resolves.toEqual({ branch: 1, response: 1 });
    await expect(run(pipeline, input, options).result).resolves.toEqual({ branch: 1, response: 1 });
    expect(inputs[0]).toBe(input);
    expect(inputs[1]).toBe(input);
  });
});

describe('run completion', () => {
  it('cancels the pending root result and releases its streams without failing done', async () => {
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const streamClosed = Promise.withResolvers<StreamEnd>();
    const events: RunEvent[] = [];
    const ending = defineEnding({
      name: 'cancellable', request: { needs: [] }, return: { provides: [] },
      execute: async (_facts, scope) => {
        scope.createStream({ label: 'owned', async *iterate() { yield 1; }, onClose: streamClosed.resolve });
        return await new Promise<never>((_resolve, reject) => {
          scope.signal.addEventListener('abort', () => reject(scope.signal.reason), { once: true });
          started.resolve();
        });
      },
    });
    const pipeline = compose()('cancellable', { entry: [], exit: [], stages: [], ending });
    const handle = run(pipeline, {}, { ...options, signal: controller.signal, events: event => events.push(event) });
    await started.promise;
    const reason = new Error('client disconnected');
    controller.abort(reason);
    await expect(handle.result).rejects.toBe(reason);
    await expect(streamClosed.promise).resolves.toEqual({ how: 'cancelled', reason });
    await expect(handle.done).resolves.toEqual({ ok: true });
    expect(events).toContainEqual(expect.objectContaining({ k: 'closed', stageId: 1, ok: true }));
    expect(events.some(event => event.k === 'fail')).toBe(false);
  });

  it('joins a deferred admitted before a throw and keeps the original failure and input facts', async () => {
    const events: RunEvent[] = [];
    const work = Promise.withResolvers<Facts>();
    const boom = new Error('transport failed', { cause: new Error('socket') });
    const end = defineEnding<Facts, Facts>({
      name: 'thrower', request: { needs: [] }, return: { provides: [] },
      execute: async (facts, scope) => {
        scope.log.info('starting', facts);
        scope.defer('measurement', work.promise);
        throw boom;
      },
    });
    const pipeline = composeTest('run', { entry: [], exit: [], stages: [], ending: end });
    const input = { detail: { at: 'terminal' } };
    const handle = run(pipeline, input, { ...options, events: event => events.push(event) });
    await expect(handle.result).rejects.toBe(boom);
    expect(events.map(event => event.k)).toEqual(['run', 'enter', 'log', 'deferred', 'fail', 'closed']);
    expect(events.find(event => event.k === 'fail')).toMatchObject({ facts: input, error: { message: 'transport failed', cause: { message: 'socket' } } });
    expect(Object.isFrozen(boom)).toBe(false);
    const value = { duration: { value: 17 } };
    work.resolve(value);
    await expect(handle.done).resolves.toMatchObject({ ok: false, error: { message: 'transport failed' } });
    expect(Object.isFrozen(value.duration)).toBe(true);
    expect(events.find(event => event.k === 'settled')).toMatchObject({ ok: true, value });
    expect(events.map(event => event.seq)).toEqual(events.map((_, index) => index + 1));
  });

  it('rejects an unsettled stream deferred and a second manual settlement', async () => {
    const events: RunEvent[] = [];
    type Result = { body: Deferred<number>; result: Deferred<number> };
    const end = defineEnding<{}, Result>({
      name: 'unsettled', request: { needs: [] }, return: { provides: ['body', 'result'] },
      execute: async (_facts, scope) => {
        const owner = scope.createStream({ label: 'body', async *iterate() { yield 1; } });
        const body = scope.deferred<number>('body measurement', owner);
        const settled = scope.deferred<number>('manual', owner);
        settled.resolve(3);
        expect(() => settled.resolve(4)).toThrow('already settled');
        await owner.close();
        return { body: body.deferred, result: settled.deferred };
      },
    });
    const pipeline = compose<Result>()('unsettled', { entry: [], exit: ['body', 'result'], stages: [], ending: end });
    const handle = run(pipeline, {}, { ...options, events: event => events.push(event) });
    const facts = await handle.result;
    await expect(facts.body.promise).rejects.toBeInstanceOf(UnsettledDeferredError);
    await expect(facts.result.promise).resolves.toBe(3);
    await expect(handle.done).resolves.toMatchObject({ ok: false, error: { name: 'UnsettledDeferredError' } });
    expect(events).toContainEqual(expect.objectContaining({
      k: 'end', how: 'released', error: expect.objectContaining({ name: 'UnsettledDeferredError', message: expect.stringContaining('body measurement') }),
    }));
  });

  it.each([
    ['input', 'stream'], ['input', 'deferred'],
    ['log', 'stream'], ['log', 'deferred'],
    ['return', 'stream'], ['return', 'deferred'],
  ] as const)('rejects a foreign handle at %s (%s)', async (boundary, kind) => {
    type Owner = {
      stream: { detail: { handle: ManagedStream<number> } };
      deferred: { detail: { handle: Deferred<number> } };
    };
    const origin = compose<Owner>()('origin', {
      entry: [], exit: ['stream', 'deferred'],
      stages: [], ending: defineEnding<{}, Owner>({
        name: 'origin', request: { needs: [] }, return: { provides: ['stream', 'deferred'] },
        execute: async (_facts, scope) => ({
          stream: { detail: { handle: scope.createStream({ label: 'owned', async *iterate() { yield 1; } }) } },
          deferred: { detail: { handle: scope.defer('owned', Promise.resolve(1)) } },
        }),
      }),
    });
    const donor = run(origin, {}, options);
    const own = await donor.result;
    const nestedForeign = own[kind];
    expect(Object.isFrozen(nestedForeign)).toBe(true);
    const ending = defineEnding<Facts, Facts>({
      name: 'recipient', request: { needs: [] }, return: { provides: [] },
      execute: async (_facts, scope) => {
        scope.defer('same trace id', Promise.resolve(2));
        if (boundary === 'log') scope.log.info('foreign', nestedForeign);
        return boundary === 'return' ? nestedForeign : {};
      },
    });
    const events: RunEvent[] = [];
    try {
      const handle = run(composeTest('recipient', { entry: [], exit: [], stages: [], ending }), boundary === 'input' ? nestedForeign : {}, {
        ...options, events: event => events.push(event),
      });
      const name = kind === 'stream' ? 'StreamOwnershipError' : 'DeferredOwnershipError';
      await expect(handle.result).rejects.toMatchObject({ name });
      await expect(handle.done).resolves.toMatchObject({ ok: false, error: { name } });
      expect(events.some(event => ('facts' in event && event.facts === nestedForeign) || (event.k === 'log' && event.fields === nestedForeign))).toBe(false);
    } finally {
      await own.stream.detail.handle.close();
      await donor.done;
    }
  });

  it('rejects pending work at the finalization deadline', async () => {
    const end = defineEnding<{}, { never: Deferred<unknown> }>({
      name: 'unsettled', request: { needs: [] }, return: { provides: ['never'] },
      execute: async (_facts, scope) => ({ never: scope.defer('pending', Promise.withResolvers().promise) }),
    });
    const handle = run(compose<{ never: Deferred<unknown> }>()('timeout', { entry: [], exit: ['never'], stages: [], ending: end }), {}, {
      ...options, finalizationTimeoutMs: 15,
    });
    const result = await handle.result;
    await expect(result.never.promise).rejects.toBeInstanceOf(FinalizationTimeoutError);
    await expect(handle.done).resolves.toMatchObject({ ok: false, error: { name: 'FinalizationTimeoutError' } });
  });

  it('expires detached work after delivery and ignores settlements after done', async () => {
    const childRelease = Promise.withResolvers<void>();
    const streamClosed = Promise.withResolvers<StreamEnd>();
    const events: RunEvent[] = [];
    const lateWork = Promise.withResolvers<number>();
    const otherWork = Promise.withResolvers<number>();
    let late: Deferred<number> | undefined;
    let other: Deferred<number> | undefined;
    const stage = defineStage<Facts, Facts, Facts, Facts>({
      name: 'detached child', through: {
        request: { ...identity, provides: ['branch'] }, response: { ...identity, provides: ['work'] },
      },
      execute: async (facts, scope) => {
        const first = await scope.next({ ...facts, branch: 1 });
        void scope.next({ ...facts, branch: 2 });
        late = scope.defer('late', lateWork.promise);
        other = scope.defer('other', otherWork.promise);
        return { ...first, work: late };
      },
    });
    const end = defineEnding<Facts, Facts>({
      name: 'stalled', request: { needs: ['branch'] }, return: { provides: ['response'] },
      execute: async (facts, scope) => {
        if (facts.branch === 2) {
          scope.createStream({ label: 'timed out', async *iterate() { yield 1; }, onClose: streamClosed.resolve });
          await childRelease.promise;
        }
        return { response: facts.branch };
      },
    });
    const pipeline = composeTest('deadline', { entry: [], exit: ['work'], stages: [stage], ending: end });
    const handle = run(pipeline, {}, {
      ...options, finalizationTimeoutMs: 15, events: event => {
        events.push(event);
        if (event.k === 'settled' && !event.ok && event.deferredId === deferredIdOf(late!)) otherWork.resolve(9);
      },
    });
    await expect(handle.result).resolves.toMatchObject({ response: 1 });
    expect(events).not.toContainEqual(expect.objectContaining({ k: 'closed', stageId: 1 }));
    await expect(handle.done).resolves.toMatchObject({ ok: false, error: { name: 'FinalizationTimeoutError' } });
    await expect(streamClosed.promise).resolves.toEqual({ how: 'errored', error: expect.any(FinalizationTimeoutError) });
    const doneCount = events.length;
    lateWork.resolve(7);
    await expect(late!.promise).rejects.toBeInstanceOf(FinalizationTimeoutError);
    await expect(other!.promise).rejects.toBeInstanceOf(FinalizationTimeoutError);
    childRelease.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(events).toHaveLength(doneCount);
  });

  it('joins sub-run completion and isolates a throwing event sink', async () => {
    const work = Promise.withResolvers<number>();
    const order: string[] = [];
    const events: RunEvent[] = [];
    const child = compose<{ response: number }>()('child', {
      entry: [], exit: ['response'],
      stages: [], ending: defineEnding({
        name: 'background', request: { needs: [] }, return: { provides: ['response'] },
        execute: async (_facts, scope) => {
          scope.defer('child work', work.promise);
          return { response: 1 };
        },
      }),
    });
    const pipeline = compose<{ response: number }>()('parent', {
      entry: [], exit: ['response'],
      stages: [], ending: defineEnding({
        name: 'parent', request: { needs: [] }, return: { provides: ['response'] },
        execute: async (_facts, scope) => {
          const sub = scope.run(child, {});
          void sub.done.then(() => order.push('child'));
          return await sub.result;
        },
      }),
    });
    const sinkError = new Error('sink');
    const onSinkError = vi.fn();
    const handle = run(pipeline, {}, {
      ...options, onSinkError, events: event => {
        events.push(event);
        if (event.k === 'enter' || event.k === 'done') throw sinkError;
      },
    });
    await expect(handle.result).resolves.toEqual({ response: 1 });
    expect(events.some(event => event.k === 'done')).toBe(false);
    work.resolve(2);
    await expect(handle.done).resolves.toEqual({
      ok: true, diagnostics: Array.from({ length: 3 }, () => expect.objectContaining({ message: 'sink' })),
    });
    expect(onSinkError.mock.calls).toEqual([[sinkError], [sinkError], [sinkError]]);
    expect(order).toEqual(['child']);
    expect(events).toContainEqual(expect.objectContaining({ k: 'enter', pipeline: 'child', edge: 'subrun', parentStageId: 1 }));
    expect(events.filter(event => event.k === 'done')).toHaveLength(1);
  });

  it('reports a throwing sink to console by default', async () => {
    const error = new Error('sink unavailable');
    const report = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const end = defineEnding({
      name: 'normal', request: { needs: [] }, return: { provides: [] }, execute: async () => ({}),
    });
    const pipeline = compose()('normal', { entry: [], exit: [], stages: [], ending: end });
    try {
      const handle = run(pipeline, {}, { ...options, events: event => { if (event.k === 'run') throw error; } });
      await expect(handle.result).resolves.toEqual({});
      await expect(handle.done).resolves.toMatchObject({ ok: true, diagnostics: [{ message: error.message }] });
      expect(report).toHaveBeenCalledExactlyOnceWith(error);
    } finally {
      report.mockRestore();
    }
  });

  it('passes the parent service object to sub-runs and folds their failures into done', async () => {
    interface Ports { readonly counter: { readonly initial: number } }
    interface Services extends Ports { readonly extra: boolean }
    const services: Services = { counter: { initial: 1 }, extra: true };
    const child = compose<{ response: number }, Ports>()('child', {
      entry: [], exit: ['response'],
      stages: [], ending: defineEnding<{}, { response: number }, {}, Ports>({
        name: 'writer', request: { needs: [] }, return: { provides: ['response'] },
        execute: async (_facts, scope) => {
          expect(scope.services).toBe(services);
          scope.defer('persistence', Promise.reject(new Error('persist failed')));
          return { response: scope.services.counter.initial };
        },
      }),
    });
    const pipeline = compose<{ response: number }, Services>()('parent', {
      entry: [], exit: ['response'],
      stages: [], ending: defineEnding<{}, { response: number }, {}, Services>({
        name: 'parent', request: { needs: [] }, return: { provides: ['response'] },
        execute: async (_facts, scope) => await scope.run(child, {}).result,
      }),
    });
    const missingPort = (scope: Scope<{ unrelated: true }>) => {
      // @ts-expect-error This stage did not declare the counter port.
      return scope.run(child, {});
    };
    expect(typeof missingPort).toBe('function');
    const handle = run(pipeline, {}, { ...options, services });
    await expect(handle.result).resolves.toEqual({ response: 1 });
    await expect(handle.done).resolves.toMatchObject({ ok: false, error: { message: 'persist failed' } });
  });

  it.each(['settles', 'expires'] as const)('shares the root deadline with a sub-run whose work %s', async outcome => {
    const work = Promise.withResolvers<number>();
    let childDone: Promise<RunDone> | undefined;
    let childDeferred: Deferred<number> | undefined;
    let childFinished = false;
    const child = compose<{ work: Deferred<number> }>()('child', {
      entry: [], exit: ['work'],
      stages: [], ending: defineEnding({
        name: 'child', request: { needs: [] }, return: { provides: ['work'] },
        execute: async (_facts, scope) => ({ work: scope.defer('child work', work.promise) }),
      }),
    });
    type Output = { body: ManagedStream<number> };
    const pipeline = compose<Output>()('parent', {
      entry: [], exit: ['body'],
      stages: [], ending: defineEnding<{}, Output>({
        name: 'parent', request: { needs: [] }, return: { provides: ['body'] },
        execute: async (_facts, scope) => {
          const sub = scope.run(child, {});
          childDone = sub.done;
          void sub.done.then(() => { childFinished = true; });
          childDeferred = (await sub.result).work;
          return { body: scope.createStream({ label: 'delivery', async *iterate() { yield 1; } }) };
        },
      }),
    });
    const handle = run(pipeline, {}, { ...options, finalizationTimeoutMs: 15 });
    const { body } = await handle.result;
    await new Promise(resolve => setTimeout(resolve, 40));
    const completedDuringDelivery = childFinished;
    if (outcome === 'settles') work.resolve(2);
    await body.close();
    expect(completedDuringDelivery).toBe(false);
    if (outcome === 'settles') {
      await expect(childDone).resolves.toEqual({ ok: true });
      await expect(handle.done).resolves.toEqual({ ok: true });
    } else {
      await expect(handle.done).resolves.toMatchObject({ ok: false, error: { name: 'FinalizationTimeoutError' } });
      await expect(childDone).resolves.toMatchObject({ ok: false, error: { name: 'FinalizationTimeoutError' } });
      await expect(childDeferred!.promise).rejects.toBeInstanceOf(FinalizationTimeoutError);
    }
  });
});
