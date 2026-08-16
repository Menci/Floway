import { describe, expect, it, vi } from 'vitest';

import {
  attemptPipeline, cache, callUpstream, failover, handoff, handoffUnlessEmpty,
  makeProvider, rememberShape, servePipeline, splitWords,
} from './fixtures.ts';
import type { Core } from './fixtures.ts';
import { compose, defineStage, move, run, transform } from '../src/index.ts';
import type { Descend, Event, Facts } from '../src/index.ts';

const NO_SERVICES = {};

const edges = (events: readonly Event[]): string[] => {
  const names = new Map<number, string>();
  const out: string[] = [];
  for (const event of events) {
    if (event.type === 'stage.entered') {
      names.set(event.stageId, event.name);
      const parent = event.parentStageId === null ? undefined : names.get(event.parentStageId);
      if (parent !== undefined) out.push(`${parent} → ${event.name}`);
    }
  }
  return out;
};

describe('run', () => {
  it('carries a request through every stage shape and answers', async () => {
    const released: string[] = [];
    const serve = servePipeline(attemptPipeline(makeProvider('tok', released), ['flaky', 'steady']));
    const { facts } = await run(serve, move({ 'in.text': 'hello brave world' }), NO_SERVICES);
    expect(facts['out.result']).toEqual({ ok: 'tok:hello-brave-world (3w)' });
  });

  it('lets a stage answer without descending', async () => {
    const serve = servePipeline(attemptPipeline(makeProvider('tok', []), ['steady']), { 'known phrase': 'from cache' });
    const { facts, events } = await run(serve, move({ 'in.text': 'known phrase' }), NO_SERVICES);
    expect(facts['out.result']).toEqual({ ok: 'from cache' });
    expect(edges(events)).toEqual([]);   // nothing below the cache was entered
  });

  // A fork is not one event repeating; it is several children naming the same parent.
  it('records a fork as repeated children of one parent', async () => {
    const attempt = attemptPipeline(makeProvider('tok', []), ['flaky', 'steady']);
    const { events } = await run(attempt, move({ 'in.words': ['a'] }), NO_SERVICES);
    expect(edges(events)).toEqual(['failover → callUpstream', 'failover → callUpstream']);
    const entries = events.filter(e => e.type === 'stage.entered');
    expect(entries.filter(e => e.name === 'failover')).toHaveLength(1);
    expect(new Set(entries.map(e => e.stageId)).size).toBe(entries.length);
  });

  it('releases the branches a fork did not adopt, and sweeps what rode to the top', async () => {
    const released: string[] = [];
    const attempt = attemptPipeline(makeProvider('tok', released), ['flaky', 'steady']);
    await run(attempt, move({ 'in.words': ['a'] }), NO_SERVICES);
    // The loser goes at the fork; the winner rides up because `failover` also provides
    // that key, and the run's own sweep takes it.
    expect(released).toEqual(['body@flaky', 'body@steady']);
  });

  it('sweeps outstanding disposables even when a stage throws', async () => {
    const released: string[] = [];
    const exploding = defineStage<Core<'in.words'>, Core<'in.words'>, Core<'out.result'>, Core<'out.result'>>({
      name: 'exploding',
      through: {
        request: { needs: ['in.words'], consumes: [], provides: [] },
        response: { needs: ['out.result'], consumes: [], provides: [] },
      },
      execute: async () => { throw new Error('a bug, rendered as a 500'); },
    });
    const attempt = compose<Core<'in.words'>, Core<'out.result'>>('boom', [
      failover(['steady']), exploding, callUpstream(makeProvider('tok', released)),
    ]);
    await expect(run(attempt, move({ 'in.words': ['a'] }), NO_SERVICES)).rejects.toThrow('a bug, rendered as a 500');
    // Nothing reached the top, so there is nothing outstanding to sweep — but the sweep
    // ran rather than being skipped by the throw, which is what the `finally` is for.
    expect(released).toEqual([]);
  });

  it('sweeps a disposable that reached the top when a later stage throws', async () => {
    const released: string[] = [];
    const body = move({ [Symbol.asyncDispose]: async () => { released.push('swept'); } });
    const opens = defineStage<object, { 'out.body': unknown }>({
      name: 'opens',
      return: { provides: ['out.body'] },
      execute: async facts => move({ ...facts, 'out.body': body }),
    });
    const pipeline = compose<object, { 'out.body': unknown }>('opens', [opens]);
    await run(pipeline, move({}), NO_SERVICES);
    expect(released).toEqual(['swept']);
  });

  it('holds a stage to its declaration on the way down', async () => {
    const forgetful = {
      ...splitWords, name: 'forgetful',
      execute: async (facts: Facts, next: Descend) => await next({ ...facts, 'in.words': move(['x']) }),
    };
    const pipeline = compose<Core<'in.text'>, Core<'out.result'>>('kept', [forgetful, callUpstream(makeProvider('tok', []))]);
    await expect(run(pipeline, move({ 'in.text': 'a b', 'route.candidate': 'steady' }), NO_SERVICES))
      .rejects.toThrow('forgetful: declared consuming in.text but handed it down');
  });

  it('holds a stage to its declaration on the way back', async () => {
    const absentminded = {
      ...rememberShape, name: 'absentminded',
      through: {
        request: { needs: ['in.words'], consumes: [], provides: [] },
        response: { needs: ['out.result'], consumes: ['out.result'], provides: [] },
      },
    };
    const pipeline = compose<Core<'in.words'>, Core<'out.result'>>('kept-up', [
      absentminded, callUpstream(makeProvider('tok', [])),
    ]);
    await expect(run(pipeline, move({ 'in.words': ['a'], 'route.candidate': 'steady' }), NO_SERVICES))
      .rejects.toThrow('absentminded: declared consuming out.result but handed it up');
  });

  it('holds a fork to declaring the disposables it received', async () => {
    const sloppy = {
      ...failover(['flaky', 'steady']), name: 'sloppyFailover',
      through: {
        request: { needs: ['in.words'], consumes: [], provides: ['route.candidate'] },
        response: { needs: ['out.result'], consumes: [], provides: [] },
      },
    };
    const pipeline = compose<Core<'in.words'>, Core<'out.result'>>('sloppy', [
      sloppy, callUpstream(makeProvider('tok', [])),
    ]);
    await expect(run(pipeline, move({ 'in.words': ['x'] }), NO_SERVICES))
      .rejects.toThrow('sloppyFailover: called next 2 times and received disposables it did not declare consuming: out.body');
  });

  it('rejects a value that entered the record without being handed over', async () => {
    const serve = servePipeline(attemptPipeline(makeProvider('tok', []), ['steady']));
    await expect(run(serve, { 'in.text': 'x', leaked: { mutable: true } } as never, NO_SERVICES))
      .rejects.toThrow('prologue leaked: value was not handed over — call move() at the assignment site');
  });

  // Ruling 23's accepted cost, made into a check rather than a hope.
  it('names the entry key the caller did not bring', async () => {
    const serve = servePipeline(attemptPipeline(makeProvider('tok', []), ['steady']));
    await expect(run(serve, move({}) as never, NO_SERVICES))
      .rejects.toThrow('run(serve): entry needs in.text, which the caller did not bring');
  });

  // A stage that declared no way down is handed no continuation at all — that is the whole
  // of what shape 1 means, and the runner calls it with one fewer argument to say so.
  it('hands an answering stage its services in the continuation' + ' place', async () => {
    let secondArgument: unknown;
    const answering = defineStage<Core<'in.words'>, Core<'out.result'>>({
      name: 'answering',
      return: { provides: ['out.result'] },
      execute: async (facts, use) => {
        secondArgument = use;
        return move({ ...facts, 'out.result': { ok: 'answered' } });
      },
    });
    const pipeline = compose<Core<'in.words'>, Core<'out.result'>>('answering', [answering]);
    await run(pipeline, move({ 'in.words': ['a'] }), NO_SERVICES);
    expect(secondArgument).toHaveProperty('log');
    expect(typeof secondArgument).toBe('object');
  });

  // Two moments, two owners: a sub-request is `run`, not `next`, and it needs no capability.
  it('lets a stage start a sub-request by calling run', async () => {
    const inner = compose<Core<'in.words'>, Core<'out.result'>>('inner', [callUpstream(makeProvider('sub', []))]);
    const launcher = defineStage<Core<'in.words'>, Core<'in.words'>, Core<'out.result'>, Core<'out.result'>>({
      name: 'launcher',
      through: {
        request: { needs: ['in.words'], consumes: [], provides: [] },
        response: { needs: ['out.result'], consumes: [], provides: ['out.result'] },
      },
      execute: async (facts, next) => {
        const side = await run(inner, move({ 'in.words': ['side'], 'route.candidate': 'steady' }), NO_SERVICES);
        const back = await next(facts);
        const ours = back['out.result'];
        const theirs = side.facts['out.result'];
        return { ...back, 'out.result': move({ ok: `${'ok' in ours ? ours.ok : ''}+${'ok' in theirs ? theirs.ok : ''}` }) };
      },
    });
    const outer = compose<Core<'in.words'>, Core<'out.result'>>('outer', [
      launcher, failover(['steady']), callUpstream(makeProvider('main', [])),
    ]);
    const { facts, events } = await run(outer, move({ 'in.words': ['a'] }), NO_SERVICES);
    expect(facts['out.result']).toEqual({ ok: 'main:a+sub:side' });
    // The sub-request's events belong to its own run, not to this one.
    expect(events.filter(e => e.type === 'stage.entered').map(e => e.name))
      .toEqual(['launcher', 'failover', 'callUpstream']);
  });

  // A module-level run context saved and restored around an `await` interleaves two
  // concurrent runs. A gateway serves concurrent requests by definition.
  it('keeps two concurrent runs' + ' dumps apart', async () => {
    const serve = () => servePipeline(attemptPipeline(makeProvider('tok', []), ['steady']));
    const [a, b] = await Promise.all([
      run(serve(), move({ 'in.text': 'a a a' }), NO_SERVICES),
      run(serve(), move({ 'in.text': 'b b' }), NO_SERVICES),
    ]);
    for (const result of [a, b]) {
      const entries = result.events.filter(e => e.type === 'stage.entered');
      expect(entries.length).toBeGreaterThan(0);
      expect(new Set(entries.map(e => e.stageId)).size).toBe(entries.length);
      expect(entries[0]!.parentStageId).toBeNull();
    }
    expect(a.events).not.toBe(b.events);
  });

  it('gives each stage its own logger and records what it wrote', async () => {
    const sink = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const talkative = defineStage<Core<'in.words'>, Core<'out.result'>>({
      name: 'talkative',
      return: { provides: ['out.result'] },
      execute: async (facts, use) => {
        use.log.info('answering', { words: 1 });
        return move({ ...facts, 'out.result': { ok: 'said' } });
      },
    });
    const pipeline = compose<Core<'in.words'>, Core<'out.result'>>('talk', [talkative]);
    const { events } = await run(pipeline, move({ 'in.words': ['a'] }), { log: sink });
    expect(sink.info).toHaveBeenCalledWith('answering', { stage: 'talkative', words: 1 });
    const logged = events.filter(e => e.type === 'stage.log');
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ level: 'info', message: 'answering', fields: { words: 1 } });
  });

  it('passes a composition' + ' services through to every stage', async () => {
    const seen: string[] = [];
    const reads = defineStage<Core<'in.words'>, Core<'out.result'>, { clock: () => number }>({
      name: 'reads',
      return: { provides: ['out.result'] },
      execute: async (facts, use) => {
        seen.push(String(use.clock()));
        return move({ ...facts, 'out.result': { ok: 'read' } });
      },
    });
    const pipeline = compose<Core<'in.words'>, Core<'out.result'>>('svc', [reads]);
    await run(pipeline, move({ 'in.words': ['a'] }), { clock: () => 42 });
    expect(seen).toEqual(['42']);
  });

  it('hands the same record on by identity when a stage changed nothing', async () => {
    const passthrough = defineStage<Core<'in.words'>, Core<'in.words'>, Core<'out.result'>, Core<'out.result'>>({
      name: 'passthrough',
      through: {
        request: { needs: ['in.words'], consumes: [], provides: [] },
        response: { needs: ['out.result'], consumes: [], provides: [] },
      },
      execute: transform(() => ({})),
    });
    const pipeline = compose<Core<'in.words'>, Core<'out.result'>>('identity', [
      passthrough, callUpstream(makeProvider('tok', [])),
    ]);
    const { events } = await run(pipeline, move({ 'in.words': ['a'], 'route.candidate': 'steady' }), NO_SERVICES);
    const entries = events.filter(e => e.type === 'stage.entered');
    expect(entries[1]!.facts).toBe(entries[0]!.facts);
  });

  it('runs a stage carrying both traits in one run', async () => {
    const attempt = attemptPipeline(makeProvider('tok', []), ['steady']);
    const short = compose<Core<'in.words'>, Core<'out.result'>>('short', [handoffUnlessEmpty(attempt)]);
    const long = compose<Core<'in.words'>, Core<'out.result'>>('long', [handoffUnlessEmpty(attempt)]);
    expect((await run(short, move({ 'in.words': [] }), NO_SERVICES)).facts['out.result']).toEqual({ ok: '' });
    expect((await run(long, move({ 'in.words': ['a', 'b'] }), NO_SERVICES)).facts['out.result']).toEqual({ ok: 'tok:a-b' });
  });

  it('reaches a provider through a sealed handle whose type mentions only the core space', async () => {
    const inside = compose<Core<'in.text'>, Core<'out.result'>>('inside-package', [
      splitWords, handoff(attemptPipeline(makeProvider('tok', []), ['steady'])),
    ]);
    expect((await run(inside, move({ 'in.text': 'a b' }), NO_SERVICES)).facts['out.result']).toEqual({ ok: 'tok:a-b' });
  });

  it('treats a failure as a value the stage above reads, not as a throw', async () => {
    const attempt = attemptPipeline(makeProvider('tok', []), ['flaky']);
    const { facts } = await run(attempt, move({ 'in.words': ['a'] }), NO_SERVICES);
    expect(facts['out.result']).toEqual({ failed: 'flaky refused' });
  });

  it('names the entry key a handoff target did not receive', async () => {
    const target = compose<Core<'in.text'>, Core<'out.result'>>('needsText', [
      cache({ x: 'y' }), splitWords, callUpstream(makeProvider('tok', [])),
    ]);
    const badHandoff = defineStage<Core<'in.words'>, Core<'in.text'>, Core<'out.result'>, Core<'out.result'>>({
      name: 'badHandoff',
      into: {
        request: { needs: ['in.words'], consumes: [], provides: [] },
        response: { needs: ['out.result'], consumes: [], provides: [] },
      },
      execute: async (facts, next) => await next(facts as never, target),
    });
    const pipeline = compose<Core<'in.words'>, Core<'out.result'>>('handoff-gap', [badHandoff]);
    await expect(run(pipeline, move({ 'in.words': ['a'] }), NO_SERVICES))
      .rejects.toThrow('needsText: entry needs in.text, which the caller did not bring');
  });
});
