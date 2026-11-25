import { getGlobalHookPostLog, LogLevel, setGlobalHookPostLog, setGlobalLogLevel } from '@guiiai/logg';
import { describe, expect, it, vi } from 'vitest';

import { factSpace, isDeferred, move, run, transform } from '../src/index.ts';
import type { Deferred, RunEvent } from '../src/index.ts';

interface Space {
  readonly 'request.mode': string;
  readonly 'request.data': { readonly number: number };
  readonly 'request.optional': string;
  readonly 'response.value': string;
  readonly 'response.left': string;
  readonly 'response.right': string;
  readonly 'response.deferred': Deferred<string>;
  readonly 'response.data': { readonly number: number };
}

const { compose, defineStage } = factSpace<Space>();
const untouched = { needs: [], provides: [], consumes: [] } as const;
const valueResponse = { ...untouched, needs: ['response.value'] } as const;
const modeRequest = { ...untouched, needs: ['request.mode'] } as const;
const scalar = defineStage({
  name: 'scalar',
  request: { needs: [] },
  return: { provides: ['response.value'] },
  execute: async () => ({ 'response.value': 'scalar' }),
});

describe('stage handoffs', () => {
  it('passes full records and keeps fact value references', async () => {
    const data = move({ number: 2 });
    const seen: RunEvent[] = [];
    const stage = defineStage({
      name: 'transform',
      through: {
        request: { ...untouched, needs: ['request.data', 'request.optional?'], provides: ['request.mode'] },
        response: { ...valueResponse, provides: ['response.value'] },
      },
      execute: transform(() => {
        let number = 0;
        return {
          request: facts => {
            number = facts['request.data'].number;
            return { ...facts, 'request.mode': 'changed' };
          },
          response: facts => ({ ...facts, 'response.value': `${facts['response.value']}:${number}` }),
        };
      }),
    });
    const ending = defineStage({
      name: 'mode',
      request: { needs: ['request.mode'] },
      return: { provides: ['response.value'] },
      execute: async facts => ({ 'response.value': facts['request.mode'] }),
    });
    const pipeline = compose('handoff', {
      entry: ['request.data', 'request.optional?'], exit: ['response.value'], stages: [stage], ending,
    });
    const facts = { 'request.data': data, 'request.open': true };
    const request = run(pipeline, facts, { services: {}, events: event => { seen.push(event); } });
    await expect(request.result).resolves.toEqual({ 'response.value': 'changed:2' });
    await request.done;
    const [first, second] = seen.filter(event => event.type === 'stage.entered');
    expect(first.facts).toBe(facts);
    expect(second.facts['request.data']).toBe(data);
    expect(second.facts['request.open']).toBe(true);
    expect(Object.hasOwn(second.facts, 'request.optional')).toBe(false);
    expect(second.parentStageId).toBe(first.stageId);
  });

  it('panics on an unmoved fact at entry, a child handoff, or return', async () => {
    const ending = defineStage({
      name: 'needs-data',
      request: { needs: ['request.data'] },
      return: { provides: ['response.value'] },
      execute: async () => ({ 'response.value': 'ok' }),
    });
    const direct = compose('direct', {
      entry: ['request.data'], exit: ['response.value'], stages: [], ending,
    });
    const rejected = run(direct, { 'request.data': { number: 1 } }, { services: {} });
    await expect(rejected.result).rejects.toThrow('"request.data" without move()');
    await expect(rejected.done).rejects.toThrow('"request.data" without move()');

    const adds = defineStage({
      name: 'unmoved',
      through: { request: { ...untouched, provides: ['request.data'] }, response: valueResponse },
      execute: async (facts, scope) => await scope.next({ ...facts, 'request.data': { number: 2 } }),
    });
    const pipeline = compose('with-child', {
      entry: [], exit: ['response.value'], stages: [adds], ending,
    });
    await expect(run(pipeline, {}, { services: {} }).done).rejects.toThrow('"request.data" without move()');

    const invalidAnswer = compose('unmoved-answer', {
      entry: [], exit: ['response.data'], stages: [],
      ending: defineStage({
        name: 'unmoved-response',
        request: { needs: [] },
        return: { provides: ['response.data'] },
        execute: async () => ({ 'response.data': { number: 2 } }),
      }),
    });
    await expect(run(invalidAnswer, {}, { services: {} }).done).rejects.toThrow('"response.data" without move()');
  });

  it('panics on missing needs, unwritten provides, and remaining consumes', async () => {
    const matching = defineStage({
      name: 'needs-mode',
      request: { needs: ['request.mode'] },
      return: { provides: ['response.value'] },
      execute: async () => ({ 'response.value': 'ok' }),
    });
    const direct = compose('matching', {
      entry: ['request.mode'], exit: ['response.value'], stages: [], ending: matching,
    });
    await expect(run(direct, {} as { 'request.mode': string }, { services: {} }).done)
      .rejects.toThrow('missing "request.mode"');

    const adds = defineStage({
      name: 'unwritten',
      through: { request: { ...untouched, provides: ['request.mode'] }, response: valueResponse },
      execute: async (_facts, scope) => await scope.next({} as { 'request.mode': string }),
    });
    const notWritten = compose('missing-write', { entry: [], exit: ['response.value'], stages: [adds], ending: matching });
    await expect(run(notWritten, {}, { services: {} }).done).rejects.toThrow('missing "request.mode"');

    const consumes = defineStage({
      name: 'consumes-mode',
      through: { request: { ...modeRequest, consumes: ['request.mode'] }, response: valueResponse },
      execute: async (facts, scope) => await scope.next(facts as unknown as { 'request.mode'?: never }),
    });
    const notConsumed = compose('unconsumed', {
      entry: ['request.mode'], exit: ['response.value'], stages: [consumes], ending: scalar,
    });
    await expect(run(notConsumed, { 'request.mode': 'live' }, { services: {} }).done).rejects.toThrow('must consume "request.mode"');
  });

  it('keeps the unique child value and checks only key provenance across several children', async () => {
    const ending = defineStage({
      name: 'choice',
      request: { needs: ['request.mode'] },
      return: { provides: ['response.value', 'response.left?', 'response.right?'] },
      execute: async facts => facts['request.mode'] === 'left'
        ? { 'response.value': 'L', 'response.left': 'left' }
        : { 'response.value': 'R', 'response.right': 'right' },
    });
    const make = (name: string, branch: number) => defineStage({
      name,
      through: {
        request: { ...modeRequest, provides: ['request.mode'] },
        response: { ...untouched, needs: ['response.value', 'response.left?', 'response.right?'] },
      },
      execute: async (facts, scope) => {
        const left = await scope.next({ ...facts, 'request.mode': 'left' });
        if (branch === 0) return { ...left, 'response.value': 'changed' };
        const right = await scope.next({ ...facts, 'request.mode': 'right' });
        return {
          ...left,
          ...right,
          'response.value': 'changed',
          ...(branch === 2 && { 'response.foreign': 'foreign' }),
        };
      },
    });
    const pipeline = (branch: number) => compose('joins', {
      entry: ['request.mode'],
      exit: ['response.value', 'response.left?', 'response.right?'],
      stages: [make('combine', branch)],
      ending,
    });
    const facts = { 'request.mode': 'host' };
    await expect(run(pipeline(0), facts, { services: {} }).done).rejects.toThrow('changed undeclared');
    const success = run(pipeline(1), facts, { services: {} });
    await expect(success.result).resolves.toEqual({
      'response.value': 'changed', 'response.left': 'left', 'response.right': 'right',
    });
    await success.done;
    await expect(run(pipeline(2), facts, { services: {} }).done).rejects.toThrow('outside its declarations and child answers');
  });

  it('uses the independent return declaration only without a continuation', async () => {
    const stage = defineStage({
      name: 'in-place',
      through: { request: modeRequest, response: valueResponse },
      return: { provides: ['response.value'] },
      execute: async (facts, scope) => facts['request.mode'] === 'skip'
        ? { 'response.value': 'in-place' }
        : await scope.next(facts),
    });
    const pipeline = compose('mixed', {
      entry: ['request.mode'], exit: ['response.value'], stages: [stage], ending: scalar,
    });
    const local = run(pipeline, { 'request.mode': 'skip' }, { services: {} });
    const child = run(pipeline, { 'request.mode': 'continue' }, { services: {} });
    await expect(local.result).resolves.toEqual({ 'response.value': 'in-place' });
    await expect(child.result).resolves.toEqual({ 'response.value': 'scalar' });
    await Promise.all([local.done, child.done]);
  });
});

describe('child calls', () => {
  it('shares the run’s fixed service instances with independent calls', async () => {
    const original = { value: 'original' };
    const services = { store: original };
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const { compose, defineStage } = factSpace<Space, typeof services>();
    const child = compose('services-child', {
      entry: [], exit: ['response.value'], stages: [],
      ending: defineStage({
        name: 'services-child',
        request: { needs: [] },
        return: { provides: ['response.value'] },
        execute: async (_facts, scope) => {
          expect(scope.services.store).toBe(original);
          return { 'response.value': scope.services.store.value };
        },
      }),
    });
    const parent = compose('services-parent', {
      entry: [], exit: ['response.value'], stages: [],
      ending: defineStage({
        name: 'services-parent',
        request: { needs: [] },
        return: { provides: ['response.value'] },
        execute: async (facts, scope) => {
          entered.resolve();
          await release.promise;
          expect(Object.isFrozen(scope.services)).toBe(true);
          return await scope.run(child, facts);
        },
      }),
    });
    const request = run(parent, {}, { services });
    await entered.promise;
    services.store = { value: 'replacement' };
    release.resolve();
    await expect(request.result).resolves.toEqual({ 'response.value': 'original' });
    await request.done;
  });

  it('uses separate identities and detaches the signal of a completed child', async () => {
    const signals: AbortSignal[] = [];
    const shared = { 'response.value': 'same' };
    const ending = defineStage({
      name: 'shared',
      request: { needs: [] },
      return: { provides: ['response.value'] },
      execute: async (_facts, scope) => {
        signals.push(scope.signal);
        return shared;
      },
    });
    const host = new AbortController();
    const stage = defineStage({
      name: 'fork',
      through: { request: untouched, response: valueResponse },
      execute: async (facts, scope) => {
        const first = scope.next(facts);
        const second = scope.next(facts);
        expect(first).not.toBe(second);
        const back = await first;
        expect(await second).toBe(back);
        scope.abort(first);
        host.abort('host stopped');
        expect(signals.map(signal => signal.aborted)).toEqual([false, false]);
        expect(scope.signal.reason).toBe('host stopped');
        return back;
      },
    });
    const pipeline = compose('forks', { entry: [], exit: ['response.value'], stages: [stage], ending });
    const request = run(pipeline, {}, { services: {}, signal: host.signal });
    await expect(request.result).resolves.toBe(shared);
    await request.done;
  });

  it.each(['foreign', 'ambiguous'] as const)('panics on a %s abort key', async mode => {
    const shared = { 'response.value': 'same' };
    const ending = defineStage({
      name: 'shared',
      request: { needs: [] },
      return: { provides: ['response.value'] },
      execute: async () => shared,
    });
    const stage = defineStage({
      name: 'abort-key',
      through: { request: untouched, response: valueResponse },
      execute: async (facts, scope) => {
        const first = await scope.next(facts);
        await scope.next(facts);
        scope.abort(mode === 'foreign' ? { ...first } : first);
        return first;
      },
    });
    const pipeline = compose('abort-keys', { entry: [], exit: ['response.value'], stages: [stage], ending });
    await expect(run(pipeline, {}, { services: {} }).done).rejects.toThrow(
      mode === 'foreign' ? 'outside its stage' : 'ambiguous child answer',
    );
  });

  it('propagates the original panic to all unsettled runs and records only the original facts', async () => {
    const events: RunEvent[] = [];
    const paused = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const failure = new Error('ordinary code bug');
    const consume = defineStage({
      name: 'child',
      request: { needs: ['request.mode'] },
      return: { provides: ['response.value'] },
      execute: async facts => {
        if (facts['request.mode'] === 'fail') throw failure;
        if (facts['request.mode'] === 'pause') {
          entered.resolve();
          await paused.promise;
        }
        return { 'response.value': facts['request.mode'] };
      },
    });
    const parent = defineStage({
      name: 'parent',
      through: { request: { ...untouched, provides: ['request.mode'] }, response: valueResponse },
      execute: async (facts, scope) => {
        await scope.next({ ...facts, 'request.mode': 'settled' });
        void scope.next({ ...facts, 'request.mode': 'pause' });
        await entered.promise;
        return await scope.next({ ...facts, 'request.mode': 'fail' });
      },
    });
    const pipeline = compose('panic', { entry: [], exit: ['response.value'], stages: [parent], ending: consume });
    const request = run(pipeline, {}, { services: {}, events: event => { events.push(event); } });
    await expect(request.result).rejects.toBe(failure);
    await expect(request.done).rejects.toBe(failure);
    paused.resolve();
    const panics = events.filter(event => event.type === 'stage.panicked');
    expect(panics.map(event => event.error)).toEqual([failure, failure, failure]);
    expect(panics.map(event => event.facts)).toEqual([{ 'request.mode': 'fail' }, undefined, undefined]);
    const settled = events.filter(event => event.type === 'stage.entered')
      .find(event => event.facts['request.mode'] === 'settled');
    expect(panics.map(event => event.stageId)).not.toContain(settled?.stageId);
  });
});

describe('deferred stage values and finalization', () => {
  it('settles a deferred fact and records the exact handle and value', async () => {
    const events: RunEvent[] = [];
    const ending = defineStage({
      name: 'settles',
      request: { needs: [] },
      return: { provides: ['response.deferred'] },
      execute: async (_facts, scope) => {
        const handle = scope.deferred<string>();
        handle.resolve('ready');
        return { 'response.deferred': handle.deferred };
      },
    });
    const pipeline = compose('deferred', {
      entry: [], exit: ['response.deferred'], stages: [], ending,
    });
    const request = run(pipeline, {}, { services: {}, events: event => { events.push(event); } });
    const answer = await request.result;
    await expect(answer['response.deferred'].promise).resolves.toBe('ready');
    expect(isDeferred(answer['response.deferred'])).toBe(true);
    expect(isDeferred({ promise: answer['response.deferred'].promise })).toBe(false);
    await request.done;
    expect(events.find(event => event.type === 'deferred.settled')).toEqual({
      type: 'deferred.settled', deferred: answer['response.deferred'], ok: true, value: 'ready',
    });
  });

  it('panics when the creating stage settles with an unsettled deferred', async () => {
    const ending = defineStage({
      name: 'unsettled-deferred',
      request: { needs: [] },
      return: { provides: ['response.deferred'] },
      execute: async (_facts, scope) => ({ 'response.deferred': scope.deferred<string>().deferred }),
    });
    const pipeline = compose('unsettled', { entry: [], exit: ['response.deferred'], stages: [], ending });
    const request = run(pipeline, {}, { services: {} });
    const result = await request.result;
    await expect(request.done).rejects.toThrow('unsettled deferred');
    await expect(result['response.deferred'].promise).rejects.toThrow('unsettled deferred');
  });

  it('waits for deferred work outside an aborted independent call', async () => {
    const work = Promise.withResolvers<void>();
    let completed = false;
    const child = compose('child', {
      entry: [], exit: ['response.value'], stages: [],
      ending: defineStage({
        name: 'child',
        request: { needs: [] },
        return: { provides: ['response.value'] },
        execute: async (_facts, scope) => {
          scope.defer(work.promise.then(() => { completed = true; }));
          expect(scope.signal.aborted).toBe(true);
          return { 'response.value': 'aborted' };
        },
      }),
    });
    const parent = compose('outer', {
      entry: [], exit: ['response.value'], stages: [],
      ending: defineStage({
        name: 'outer',
        request: { needs: [] },
        return: { provides: ['response.value'] },
        execute: async (facts, scope) => {
          const call = scope.run(child, facts);
          scope.abort(call);
          return await call;
        },
      }),
    });
    const request = run(parent, {}, { services: {} });
    await expect(request.result).resolves.toEqual({ 'response.value': 'aborted' });
    expect(completed).toBe(false);
    work.resolve();
    await request.done;
    expect(completed).toBe(true);
  });

  it('exposes finalization failure after a successful response', async () => {
    const failure = new Error('post-response write failed');
    const work = Promise.withResolvers<void>();
    const pipeline = compose('finalization-failure', {
      entry: [], exit: ['response.value'], stages: [],
      ending: defineStage({
        name: 'defers',
        request: { needs: [] },
        return: { provides: ['response.value'] },
        execute: async (_facts, scope) => {
          scope.defer(work.promise);
          return { 'response.value': 'delivered' };
        },
      }),
    });
    const request = run(pipeline, {}, { services: {} });
    await expect(request.result).resolves.toEqual({ 'response.value': 'delivered' });
    work.reject(failure);
    await expect(request.done).rejects.toBe(failure);
  });

  it('writes the logg entry to both the global sink and the entered stage', async () => {
    const events: RunEvent[] = [];
    const global = vi.fn();
    const previous = getGlobalHookPostLog();
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    setGlobalLogLevel(LogLevel.Log);
    setGlobalHookPostLog(global);
    try {
      const pipeline = compose('logging', {
        entry: [], exit: ['response.value'], stages: [],
        ending: defineStage({
          name: 'logging',
          request: { needs: [] },
          return: { provides: ['response.value'] },
          execute: async (_facts, scope) => {
            scope.log.withField('count', 3).log('Logged');
            return { 'response.value': 'ok' };
          },
        }),
      });
      const request = run(pipeline, {}, { services: {}, events: event => { events.push(event); } });
      await request.done;
      expect(events.map(event => event.type)).toEqual(['stage.entered', 'log', 'stage.leaved']);
      expect(global).toHaveBeenCalledOnce();
      expect(events[1]).toEqual({ type: 'log', stageId: 1, ...global.mock.calls[0][0] });
      expect(output).toHaveBeenCalledOnce();
    } finally {
      output.mockRestore();
      setGlobalHookPostLog(previous);
    }
  });

  it('exposes an event emitted by unregistered work after finalization', async () => {
    let emitLate!: () => void;
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    setGlobalLogLevel(LogLevel.Log);
    const events: RunEvent[] = [];
    try {
      const pipeline = compose('late-emitter', {
        entry: [], exit: ['response.value'], stages: [],
        ending: defineStage({
          name: 'late-emitter',
          request: { needs: [] },
          return: { provides: ['response.value'] },
          execute: async (_facts, scope) => {
            emitLate = () => { scope.log.log('Late entry'); };
            return { 'response.value': 'ok' };
          },
        }),
      });
      await run(pipeline, {}, { services: {}, events: event => { events.push(event); } }).done;
      expect(() => emitLate()).toThrow('Cannot emit pipeline events after finalization');
      expect(events.map(event => event.type)).toEqual(['stage.entered', 'stage.leaved']);
    } finally {
      output.mockRestore();
    }
  });
});
