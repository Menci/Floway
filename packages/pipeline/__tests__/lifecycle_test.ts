import { describe, expect, it } from 'vitest';

import { compose, defer, defineStage, getFailureFacts, move, own, run, setRelease } from '../src/index.ts';

const answer = defineStage<Record<string, never>, Record<string, never>>({
  name: 'answer', return: { provides: [] }, execute: async facts => facts,
});

describe('run lifetime', () => {
  it('changes the release action without adopting a resource twice', async () => {
    let cancelled = 0;
    let drained = 0;
    const resource = move(own({}, async () => { cancelled++; }));
    setRelease(resource, async () => { drained++; });
    await resource[Symbol.asyncDispose]();
    await resource[Symbol.asyncDispose]();
    expect(cancelled).toBe(0);
    expect(drained).toBe(1);
    expect(() => setRelease(resource, async () => {})).toThrow('after disposal has started');
  });

  it('composes the previous release action without recursively awaiting its own disposal', async () => {
    const steps: string[] = [];
    const resource = move(own({}, async () => { steps.push('drain'); }));
    const previous = setRelease(resource, async () => {
      try { await previous(); } finally { steps.push('settle'); }
    });
    await resource[Symbol.asyncDispose]();
    await resource[Symbol.asyncDispose]();
    expect(steps).toEqual(['drain', 'settle']);
  });

  it('cleans an initial resource consumed before the first handover', async () => {
    let released = 0;
    const body = move(own({}, async () => { released++; }));
    const consume = defineStage<{ body: typeof body }, Record<string, never>, Record<string, never>, Record<string, never>>({
      name: 'consume',
      through: {
        request: { needs: ['body'], consumes: ['body'], provides: [] },
        response: { needs: [], consumes: [], provides: [] },
      },
      execute: async (_facts, next) => await next(move({})),
    });
    const result = await run(compose('initialResource', [consume, answer]), move({ body }), {});
    await result.drain();
    expect(released).toBe(1);
  });

  it('waits for an initial deferred fact even after it is consumed', async () => {
    let finish!: () => void;
    const pending = defer(new Promise<void>(resolve => { finish = resolve; }));
    const consume = defineStage<{ pending: typeof pending }, Record<string, never>, Record<string, never>, Record<string, never>>({
      name: 'consume',
      through: {
        request: { needs: ['pending'], consumes: ['pending'], provides: [] },
        response: { needs: [], consumes: [], provides: [] },
      },
      execute: async (_facts, next) => await next(move({})),
    });
    const result = await run(compose('initialDeferred', [consume, answer]), move({ pending }), {});
    let drained = false;
    const draining = result.drain().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    finish();
    await draining;
    expect(drained).toBe(true);
  });

  it('shares one disposal between manual release and the runner', async () => {
    let releases = 0;
    const ending = defineStage<Record<string, never>, { body: ReturnType<typeof own> }>({
      name: 'ending', return: { provides: ['body'] },
      execute: async () => move({ body: own({}, async () => { releases++; }) }),
    });
    const manual = defineStage<Record<string, never>, Record<string, never>, { body: ReturnType<typeof own> }, Record<string, never>>({
      name: 'manual',
      through: {
        request: { needs: [], consumes: [], provides: [] },
        response: { needs: ['body'], consumes: ['body'], provides: [] },
      },
      execute: async (facts, next) => {
        const back = await next(facts);
        await back.body[Symbol.asyncDispose]();
        return move({});
      },
    });
    const result = await run(compose('manualRelease', [manual, ending]), move({}), {});
    await result.drain();
    expect(releases).toBe(1);
  });

  it('shares the unfinished drain with concurrent callers', async () => {
    let finish!: () => void;
    const body = move(own({}, () => new Promise<void>(resolve => { finish = resolve; })));
    const result = await run(compose('concurrentDrain', [answer]), move({ body }), {});
    const first = result.drain();
    expect(result.drain()).toBe(first);
    finish();
    await first;
  });

  it('preserves a stage failure and cleanup failures while releasing every resource', async () => {
    const stageError = new Error('stage failed');
    const cleanupError = new Error('cleanup failed');
    let lastReleased = false;
    const ending = defineStage<Record<string, never>, { bad: ReturnType<typeof own>; good: ReturnType<typeof own> }>({
      name: 'ending', return: { provides: ['bad', 'good'] },
      execute: async () => move({
        bad: own({}, async () => { throw cleanupError; }),
        good: own({}, async () => { lastReleased = true; }),
      }),
    });
    const fail = defineStage<Record<string, never>, Record<string, never>, { bad: ReturnType<typeof own> }, Record<string, never>>({
      name: 'fail',
      through: {
        request: { needs: [], consumes: [], provides: [] },
        response: { needs: ['bad'], consumes: [], provides: [] },
      },
      execute: async (facts, next) => { await next(facts); throw stageError; },
    });
    const caught = await run(compose('cleanupFailure', [fail, ending]), move({}), {}).catch(error => error as AggregateError);
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toEqual([stageError, cleanupError]);
    expect((caught as AggregateError).cause).toBe(stageError);
    expect(lastReleased).toBe(true);
    expect(getFailureFacts(caught)).toHaveProperty('bad');
  });

  it('returns the deepest failure facts with the original error object', async () => {
    const error = new Error('failed');
    const ending = defineStage<{ position: number }, Record<string, never>>({
      name: 'ending', return: { provides: [] }, execute: async () => { throw error; },
    });
    const descend = defineStage<Record<string, never>, { position: number }, Record<string, never>, Record<string, never>>({
      name: 'descend',
      through: {
        request: { needs: [], consumes: [], provides: ['position'] },
        response: { needs: [], consumes: [], provides: [] },
      },
      execute: async (facts, next) => await next(move({ ...facts, position: 42 })),
    });
    await expect(run(compose('faultFacts', [descend, ending]), move({}), {})).rejects.toBe(error);
    expect(getFailureFacts(error)).toEqual({ position: 42 });
  });

  it('captures returned response facts for an error above the upstream call', async () => {
    const error = new Error('response rewrite failed');
    const ending = defineStage<Record<string, never>, { upstream: string; response: string }>({
      name: 'upstream', return: { provides: ['upstream', 'response'] },
      execute: async facts => move({ ...facts, upstream: 'provider-a', response: 'answer' }),
    });
    const rewrite = defineStage<Record<string, never>, Record<string, never>, { response: string }, Record<string, never>>({
      name: 'rewrite',
      through: {
        request: { needs: [], consumes: [], provides: [] },
        response: { needs: ['response'], consumes: [], provides: [] },
      },
      execute: async (facts, next) => { await next(facts); throw error; },
    });
    await expect(run(compose('responseFault', [rewrite, ending]), move({}), {})).rejects.toBe(error);
    expect(getFailureFacts(error)).toEqual({ upstream: 'provider-a', response: 'answer' });
  });

  it('checks declared needs after a stage drops an undeclared fact', async () => {
    const drop = defineStage<{ input: string }, Record<string, never>, Record<string, never>, Record<string, never>>({
      name: 'drop',
      through: {
        request: { needs: ['input'], consumes: [], provides: [] },
        response: { needs: [], consumes: [], provides: [] },
      },
      execute: async (_facts, next) => await next(move({})),
    });
    const needs = defineStage<{ input: string }, { input: string }, Record<string, never>, Record<string, never>>({
      name: 'needsInput',
      through: {
        request: { needs: ['input'], consumes: [], provides: [] },
        response: { needs: [], consumes: [], provides: [] },
      },
      execute: async (facts, next) => await next(facts),
    });
    await expect(run(compose('missingNeed', [drop, needs, answer]), move({ input: 'hello' }), {}))
      .rejects.toThrow('needsInput entering: needs input');
  });
});
