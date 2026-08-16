import { describe, expect, it, vi } from 'vitest';

import {
  attemptPipeline, cache, callUpstream, failover, handoff, handoffUnlessEmpty,
  makeProvider, rememberShape, servePipeline, splitWords,
} from './fixtures.ts';
import type { Core } from './fixtures.ts';
import { compose, defineStage, isOwned, move, own, run, transform } from '../src/index.ts';
import type { Descend, Event, Facts } from '../src/index.ts';

/** No dump sink, so nothing records — which is the ordinary case. */
const PLAIN = {};

/** With a sink, so the run's events are delivered as they happen. */
const recorded = () => {
  const seen: Event[] = [];
  return { services: { dump: (event: Event) => { seen.push(event); } }, seen };
};

const edges = (events: readonly Event[]): string[] => {
  const names = new Map<number, string>();
  const out: string[] = [];
  for (const event of events) {
    if (event.type !== 'stage.entered') continue;
    names.set(event.stageId, event.name);
    const parent = event.parentStageId === null ? undefined : names.get(event.parentStageId);
    if (parent !== undefined) out.push(`${parent} → ${event.name}`);
  }
  return out;
};

const body = (label: string, released: string[]) =>
  move(own({ label }, async () => { released.push(label); }));

describe('run', () => {
  it('carries a request through every stage shape and answers', async () => {
    const serve = servePipeline(attemptPipeline(makeProvider('tok', []), ['flaky', 'steady']));
    const { facts } = await run(serve, move({ 'in.text': 'hello brave world' }), PLAIN);
    expect(facts['out.result']).toEqual({ ok: 'tok:hello-brave-world (3w)' });
  });

  it('lets a stage answer without descending', async () => {
    const { services, seen } = recorded();
    const serve = servePipeline(attemptPipeline(makeProvider('tok', []), ['steady']), { 'known phrase': 'from cache' });
    const { facts } = await run(serve, move({ 'in.text': 'known phrase' }), services);
    expect(facts['out.result']).toEqual({ ok: 'from cache' });
    expect(edges(seen)).toEqual([]);   // nothing below the cache was entered
  });

  // A fork is not one event repeating; it is several children naming the same parent.
  it('records a fork as repeated children of one parent', async () => {
    const { services, seen } = recorded();
    const attempt = attemptPipeline(makeProvider('tok', []), ['flaky', 'steady']);
    await run(attempt, move({ 'in.words': ['a'] }), services);
    expect(edges(seen)).toEqual(['failover → callUpstream', 'failover → callUpstream']);
    const entries = seen.filter(e => e.type === 'stage.entered');
    expect(entries.filter(e => e.name === 'failover')).toHaveLength(1);
    expect(new Set(entries.map(e => e.stageId)).size).toBe(entries.length);
  });

  it('delivers each event to the sink as it happens, not in one batch at the end', async () => {
    const order: string[] = [];
    const attempt = attemptPipeline(makeProvider('tok', []), ['steady']);
    const { events } = await run(attempt, move({ 'in.words': ['a'] }), {
      dump: (event: Event) => { order.push(event.type); },
    });
    expect(order.length).toBe(events.length);
    expect(order[0]).toBe('stage.entered');
  });

  it('records nothing at all when the prologue resolved no dump sink', async () => {
    const attempt = attemptPipeline(makeProvider('tok', []), ['steady']);
    const { events } = await run(attempt, move({ 'in.words': ['a'] }), PLAIN);
    expect(events).toEqual([]);
  });
});

describe('what the run owns', () => {
  it('releases the branch a fork did not adopt, and leaves the winner for the drain', async () => {
    const released: string[] = [];
    const attempt = attemptPipeline(makeProvider('tok', released), ['flaky', 'steady']);
    const { drain } = await run(attempt, move({ 'in.words': ['a'] }), PLAIN);
    expect(released).toEqual(['body@flaky']);          // the loser, at the fork
    await drain();
    expect(released).toEqual(['body@flaky', 'body@steady']);
  });

  // Awaiting the drain before answering would eat a streaming family's frames and block
  // the handler for as long as the upstream keeps writing.
  it('answers before draining, so a live stream can be handed back', async () => {
    const released: string[] = [];
    let drained = false;
    const slow = move(own({}, async () => {
      await new Promise(resolve => setTimeout(resolve, 30));
      drained = true;
      released.push('slow');
    }));
    const opens = defineStage<object, { 'out.body': unknown }>({
      name: 'opens',
      return: { provides: ['out.body'] },
      execute: async facts => move({ ...facts, 'out.body': slow }),
    });
    const pipeline = compose<object, { 'out.body': unknown }>('opens', [opens]);
    const { drain } = await run(pipeline, move({}), PLAIN);
    expect(drained).toBe(false);       // the answer came back first
    await drain();
    expect(released).toEqual(['slow']);
  });

  // The case the guarantee exists for: a body opened below a throw must not be abandoned,
  // because an aborted connection cannot be reused and leaves its billing unsettled.
  it('releases a body opened below a stage that threw', async () => {
    const released: string[] = [];
    const thrower = defineStage<Core<'in.words'>, Core<'in.words'>, Core<'out.result'>, Core<'out.result'>>({
      name: 'thrower',
      through: {
        request: { needs: ['in.words'], consumes: [], provides: [] },
        response: { needs: ['out.result'], consumes: [], provides: [] },
      },
      execute: async (facts, next) => {
        await next(facts);
        throw new Error('a bug, rendered as a 500');
      },
    });
    const pipeline = compose<Core<'in.words'>, Core<'out.result'>>('boom', [
      thrower, callUpstream(makeProvider('tok', released)),
    ]);
    await expect(run(pipeline, move({ 'in.words': ['a'], 'route.candidate': 'steady' }), PLAIN))
      .rejects.toThrow('a bug, rendered as a 500');
    expect(released).toEqual(['body@steady']);
  });

  it('keeps the dump of a run that threw', async () => {
    const { services, seen } = recorded();
    const thrower = defineStage<Core<'in.words'>, Core<'out.result'>>({
      name: 'thrower',
      return: { provides: ['out.result'] },
      execute: async () => { throw new Error('a bug'); },
    });
    const pipeline = compose<Core<'in.words'>, Core<'out.result'>>('lost', [thrower]);
    await expect(run(pipeline, move({ 'in.words': ['a'] }), services)).rejects.toThrow('a bug');
    expect(seen.map(e => e.type)).toEqual(['stage.entered']);
  });

  // A key the stage declared it consumes is one it took ownership of. Ownership is a
  // declaration, not an arity, so descending once claims it as surely as forking does.
  it('releases a consumed body even when the stage descended exactly once', async () => {
    const released: string[] = [];
    const swallows = defineStage<Core<'in.words'>, Core<'in.words'>, Core<'out.result' | 'out.body'>, Core<'out.result'>>({
      name: 'swallows',
      through: {
        request: { needs: ['in.words'], consumes: [], provides: [] },
        response: { needs: ['out.result'], consumes: ['out.body'], provides: [] },
      },
      execute: async (facts, next) => {
        const { 'out.body': gone, ...rest } = await next(facts);
        void gone;
        return rest;
      },
    });
    const pipeline = compose<Core<'in.words'>, Core<'out.result'>>('owned', [
      swallows, callUpstream(makeProvider('tok', released)),
    ]);
    const { drain } = await run(pipeline, move({ 'in.words': ['a'], 'route.candidate': 'steady' }), PLAIN);
    expect(released).toEqual(['body@steady']);
    await drain();
    expect(released).toEqual(['body@steady']);   // released once, not twice
  });

  // Identity, not the key: a stage that hands a body up under a different name must not
  // have it drained out from under whoever is reading it.
  it('does not release a body the stage handed up under another key', async () => {
    const released: string[] = [];
    const kept = body('kept', released);
    const opens = defineStage<Core<'in.words'>, { 'out.body': unknown; 'out.result': unknown }>({
      name: 'opens',
      return: { provides: ['out.body', 'out.result'] },
      execute: async facts => move({ ...facts, 'out.body': kept, 'out.result': { ok: 'x' } }),
    });
    const renames = defineStage<
      Core<'in.words'>, Core<'in.words'>,
      { 'out.body': unknown; 'out.result': unknown }, { 'out.kept': unknown; 'out.result': unknown }
    >({
      name: 'renames',
      through: {
        request: { needs: ['in.words'], consumes: [], provides: [] },
        response: { needs: ['out.result'], consumes: ['out.body'], provides: ['out.kept'] },
      },
      execute: async (facts, next) => {
        const { 'out.body': moved, ...rest } = await next(facts);
        return { ...rest, 'out.kept': moved };
      },
    });
    const pipeline = compose<Core<'in.words'>, { 'out.result': unknown }>('rename', [renames, opens]);
    const { drain } = await run(pipeline, move({ 'in.words': ['a'] }), PLAIN);
    expect(released).toEqual([]);      // still live: somebody above holds it
    await drain();
    expect(released).toEqual(['kept']);
  });

  // Ownership is claimed, never sniffed. The language hands `Symbol.asyncDispose` out on
  // its own terms and they do not match ours in either direction — every async generator
  // has it, and a `ReadableStream`, which is what a body actually is, does not. Sniffing
  // would adopt a transducer's own iterator as a run resource and release it the moment its
  // stage handed up, while missing the upstream body the rule exists for.
  it('does not adopt an async generator, which the language marks disposable', async () => {
    const frames = (async function* () { yield 1; yield 2; })();
    expect(Symbol.asyncDispose in frames).toBe(true);        // the language says yes
    expect(isOwned(frames)).toBe(false);                     // the run says no

    const opens = defineStage<object, { 'out.frames': unknown }>({
      name: 'opens',
      return: { provides: ['out.frames'] },
      execute: async facts => move({ ...facts, 'out.frames': frames }),
    });
    const pipeline = compose<object, { 'out.frames': unknown }>('frames', [opens]);
    const { facts, drain } = await run(pipeline, move({}), PLAIN);
    await drain();
    // Still readable: nothing released it out from under whoever holds it.
    expect(await (facts['out.frames'] as AsyncGenerator<number>).next()).toEqual({ value: 1, done: false });
  });

  it('does adopt a ReadableStream, which the language does not mark at all', async () => {
    const released: string[] = [];
    const stream = new ReadableStream<number>();
    expect(Symbol.asyncDispose in stream).toBe(false);       // the language says no
    const body = move(own(stream, async () => { released.push('drained'); }));
    const opens = defineStage<object, { 'out.body': unknown }>({
      name: 'opens',
      return: { provides: ['out.body'] },
      execute: async facts => move({ ...facts, 'out.body': body }),
    });
    const pipeline = compose<object, { 'out.body': unknown }>('body', [opens]);
    const { drain } = await run(pipeline, move({}), PLAIN);
    await drain();
    expect(released).toEqual(['drained']);
  });

  it('passes an owned value nobody declared straight through to the run', async () => {
    const released: string[] = [];
    const undeclared = body('undeclared', released);
    const opens = defineStage<object, { 'out.body': unknown }>({
      name: 'opens',
      return: { provides: ['out.body'] },
      execute: async facts => move({ ...facts, 'out.body': undeclared }),
    });
    const pipeline = compose<object, { 'out.body': unknown }>('rides', [opens]);
    const { drain } = await run(pipeline, move({}), PLAIN);
    expect(released).toEqual([]);
    await drain();
    expect(released).toEqual(['undeclared']);
  });
});

describe('what the runner checks', () => {
  it('holds a stage to its `consumes` on the way down', async () => {
    const forgetful = {
      ...splitWords, name: 'forgetful',
      execute: async (facts: Facts, next: Descend) => await next({ ...facts, 'in.words': move(['x']) }),
    };
    const pipeline = compose<Core<'in.text'>, Core<'out.result'>>('kept', [forgetful, callUpstream(makeProvider('tok', []))]);
    await expect(run(pipeline, move({ 'in.text': 'a b', 'route.candidate': 'steady' }), PLAIN))
      .rejects.toThrow('forgetful: declared consuming in.text but handed it down');
  });

  it('holds a stage to its `consumes` on the way back', async () => {
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
    await expect(run(pipeline, move({ 'in.words': ['a'], 'route.candidate': 'steady' }), PLAIN))
      .rejects.toThrow('absentminded: declared consuming out.result but handed it up');
  });

  it('holds a stage to its `provides` on the way down', async () => {
    const promises = {
      ...splitWords, name: 'promises',
      execute: async (facts: Facts, next: Descend) => {
        const { 'in.text': gone, ...rest } = facts;
        void gone;
        return await next(rest);
      },
    };
    const pipeline = compose<Core<'in.text'>, Core<'out.result'>>('promised', [promises, callUpstream(makeProvider('tok', []))]);
    await expect(run(pipeline, move({ 'in.text': 'a b', 'route.candidate': 'steady' }), PLAIN))
      .rejects.toThrow('promises: declared providing in.words but did not');
  });

  it('holds a stage to its `provides` on the way back', async () => {
    const forgets = defineStage<Core<'in.words'>, Core<'in.words'>, Core<'out.result'>, Core<'out.result'>>({
      name: 'forgets',
      through: {
        request: { needs: ['in.words'], consumes: [], provides: [] },
        response: { needs: ['out.result'], consumes: ['out.result'], provides: ['out.summary'] as never },
      },
      execute: async (facts, next) => {
        const { 'out.result': gone, ...rest } = await next(facts);
        void gone;
        return rest as never;
      },
    });
    const pipeline = compose<Core<'in.words'>, Core<'out.result'>>('forgot', [
      forgets, callUpstream(makeProvider('tok', [])),
    ]);
    await expect(run(pipeline, move({ 'in.words': ['a'], 'route.candidate': 'steady' }), PLAIN))
      .rejects.toThrow('forgets: declared providing out.summary but did not');
  });

  it('holds an answering stage to its `provides`', async () => {
    const silent = defineStage<Core<'in.words'>, Core<'out.result'>>({
      name: 'silent',
      return: { provides: ['out.result'] },
      execute: async facts => facts as never,
    });
    const pipeline = compose<Core<'in.words'>, Core<'out.result'>>('silent', [silent]);
    await expect(run(pipeline, move({ 'in.words': ['a'] }), PLAIN))
      .rejects.toThrow('silent: declared providing out.result but did not');
  });

  it('holds a fork to declaring the releasables it received', async () => {
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
    await expect(run(pipeline, move({ 'in.words': ['x'] }), PLAIN))
      .rejects.toThrow('sloppyFailover: called next 2 times and received releasables it did not declare consuming: out.body');
  });

  it('rejects a value the prologue never handed over', async () => {
    const serve = servePipeline(attemptPipeline(makeProvider('tok', []), ['steady']));
    await expect(run(serve, { 'in.text': 'x', leaked: { mutable: true } } as never, PLAIN))
      .rejects.toThrow('prologue leaked: value was not handed over — call move() at the assignment site');
  });

  it('rejects a value a stage never handed over, naming the stage and the key', async () => {
    const leaks = {
      ...splitWords, name: 'leaks',
      execute: async (facts: Facts, next: Descend) => {
        const { 'in.text': gone, ...rest } = facts;
        void gone;
        return await next({ ...rest, 'in.words': ['x'] });   // no move()
      },
    };
    const pipeline = compose<Core<'in.text'>, Core<'out.result'>>('leaky', [leaks, callUpstream(makeProvider('tok', []))]);
    await expect(run(pipeline, move({ 'in.text': 'a b', 'route.candidate': 'steady' }), PLAIN))
      .rejects.toThrow('leaks handing down in.words: value was not handed over');
  });

  it('rejects a value a stage never handed over on the way back', async () => {
    const leaksUp = defineStage<Core<'in.words'>, Core<'in.words'>, Core<'out.result'>, Core<'out.result'>>({
      name: 'leaksUp',
      through: {
        request: { needs: ['in.words'], consumes: [], provides: [] },
        response: { needs: ['out.result'], consumes: [], provides: ['out.result'] },
      },
      execute: async (facts, next) => ({ ...await next(facts), 'out.result': { ok: 'unmoved' } }),
    });
    const pipeline = compose<Core<'in.words'>, Core<'out.result'>>('leaky-up', [
      leaksUp, callUpstream(makeProvider('tok', [])),
    ]);
    await expect(run(pipeline, move({ 'in.words': ['a'], 'route.candidate': 'steady' }), PLAIN))
      .rejects.toThrow('leaksUp handing up out.result: value was not handed over');
  });

  // Ruling 23's accepted cost, made into a check rather than a hope.
  it('names the entry key the caller did not bring', async () => {
    const serve = servePipeline(attemptPipeline(makeProvider('tok', []), ['steady']));
    await expect(run(serve, move({}) as never, PLAIN))
      .rejects.toThrow('run(serve): serve needs in.text, which it was not given');
  });

  it('names both the caller and the target when a handoff falls short', async () => {
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
    await expect(run(pipeline, move({ 'in.words': ['a'] }), PLAIN))
      .rejects.toThrow('badHandoff handing off: needsText needs in.text, which it was not given');
  });

  // The record a stage builds with a spread is a fresh object that `move` never touched —
  // so this is the freeze the runner itself applies, and it is what lets the dump treat
  // "the same object" as "this side changed nothing".
  it('freezes a record a stage built, so a recorded state cannot be rewritten', async () => {
    const { services, seen } = recorded();
    const serve = servePipeline(attemptPipeline(makeProvider('tok', []), ['steady']));
    await run(serve, move({ 'in.text': 'a b' }), services);
    const built = seen.filter(e => e.type === 'stage.entered')
      .map(e => e.facts)
      .find(facts => 'in.words' in facts)!;
    expect(Object.isFrozen(built)).toBe(true);
    expect(() => { (built as Record<string, unknown>)['in.words'] = ['rewritten']; }).toThrow(TypeError);
  });

  it('freezes the record the prologue built', async () => {
    const initial = move({ 'in.words': ['a'] });
    const attempt = attemptPipeline(makeProvider('tok', []), ['steady']);
    await run(attempt, initial, PLAIN);
    expect(Object.isFrozen(initial)).toBe(true);
  });

  it('hands the same record on by identity when a stage changed nothing', async () => {
    const { services, seen } = recorded();
    const unchanged = defineStage<Core<'in.words'>, Core<'in.words'>, Core<'out.result'>, Core<'out.result'>>({
      name: 'unchanged',
      through: {
        request: { needs: ['in.words'], consumes: [], provides: [] },
        response: { needs: ['out.result'], consumes: [], provides: [] },
      },
      execute: transform(() => ({})),
    });
    const pipeline = compose<Core<'in.words'>, Core<'out.result'>>('identity', [
      unchanged, callUpstream(makeProvider('tok', [])),
    ]);
    await run(pipeline, move({ 'in.words': ['a'], 'route.candidate': 'steady' }), services);
    const entries = seen.filter(e => e.type === 'stage.entered');
    expect(entries[1]!.facts).toBe(entries[0]!.facts);
  });
});

describe('what a stage is given', () => {
  it('gives an answering stage its services where a continuation would be', async () => {
    let second: unknown;
    const answering = defineStage<Core<'in.words'>, Core<'out.result'>>({
      name: 'answering',
      return: { provides: ['out.result'] },
      execute: async (facts, use) => {
        second = use;
        return move({ ...facts, 'out.result': { ok: 'answered' } });
      },
    });
    const pipeline = compose<Core<'in.words'>, Core<'out.result'>>('answering', [answering]);
    await run(pipeline, move({ 'in.words': ['a'] }), PLAIN);
    expect(second).toHaveProperty('log');
  });

  it('gives each stage its own logger and records what it wrote', async () => {
    const sink = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const seen: Event[] = [];
    const talkative = defineStage<Core<'in.words'>, Core<'out.result'>>({
      name: 'talkative',
      return: { provides: ['out.result'] },
      execute: async (facts, use) => {
        use.log.info('answering', { words: 1 });
        return move({ ...facts, 'out.result': { ok: 'said' } });
      },
    });
    const pipeline = compose<Core<'in.words'>, Core<'out.result'>>('talk', [talkative]);
    await run(pipeline, move({ 'in.words': ['a'] }), { log: sink, dump: (e: Event) => { seen.push(e); } });
    expect(sink.info).toHaveBeenCalledWith('answering', { stage: 'talkative', words: 1 });
    const logged = seen.filter(e => e.type === 'stage.log');
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ level: 'info', message: 'answering', fields: { words: 1 } });
  });

  // A stored line has to be a state that existed, for the same reason the record is frozen.
  it('snapshots a log line, so a later write by the caller cannot drift into it', async () => {
    const seen: Event[] = [];
    const fields: Record<string, unknown> = { attempt: 1 };
    const talkative = defineStage<Core<'in.words'>, Core<'out.result'>>({
      name: 'talkative',
      return: { provides: ['out.result'] },
      execute: async (facts, use) => {
        use.log.warn('slow', fields);
        fields['attempt'] = 2;
        return move({ ...facts, 'out.result': { ok: 'said' } });
      },
    });
    const pipeline = compose<Core<'in.words'>, Core<'out.result'>>('talk', [talkative]);
    await run(pipeline, move({ 'in.words': ['a'] }), { dump: (e: Event) => { seen.push(e); } });
    expect(seen.find(e => e.type === 'stage.log')).toMatchObject({ fields: { attempt: 1 } });
  });

  it('passes the composition-owned services through to every stage', async () => {
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
});

describe('runs beside each other', () => {
  // A module-level run context saved and restored around an `await` interleaves two
  // concurrent runs. A gateway serves concurrent requests by definition.
  it('keeps two concurrent runs apart', async () => {
    const serve = () => servePipeline(attemptPipeline(makeProvider('tok', []), ['steady']));
    const a = recorded();
    const b = recorded();
    await Promise.all([
      run(serve(), move({ 'in.text': 'a a a' }), a.services),
      run(serve(), move({ 'in.text': 'b b' }), b.services),
    ]);
    for (const { seen } of [a, b]) {
      const entries = seen.filter(e => e.type === 'stage.entered');
      expect(entries.length).toBeGreaterThan(0);
      expect(new Set(entries.map(e => e.stageId)).size).toBe(entries.length);
      expect(entries[0]!.parentStageId).toBeNull();
    }
    expect(a.seen).not.toBe(b.seen);
  });

  // Two moments, two owners: a sub-request is `run`, not `next`, and it needs no capability.
  it('lets a stage start a sub-request, whose events belong to its own run', async () => {
    const { services, seen } = recorded();
    const inner = compose<Core<'in.words'>, Core<'out.result'>>('inner', [callUpstream(makeProvider('sub', []))]);
    const launcher = defineStage<Core<'in.words'>, Core<'in.words'>, Core<'out.result'>, Core<'out.result'>>({
      name: 'launcher',
      through: {
        request: { needs: ['in.words'], consumes: [], provides: [] },
        response: { needs: ['out.result'], consumes: [], provides: ['out.result'] },
      },
      execute: async (facts, next) => {
        const side = await run(inner, move({ 'in.words': ['side'], 'route.candidate': 'steady' }), {});
        const back = await next(facts);
        const ours = back['out.result'];
        const theirs = side.facts['out.result'];
        return { ...back, 'out.result': move({ ok: `${'ok' in ours ? ours.ok : ''}+${'ok' in theirs ? theirs.ok : ''}` }) };
      },
    });
    const outer = compose<Core<'in.words'>, Core<'out.result'>>('outer', [
      launcher, failover(['steady']), callUpstream(makeProvider('main', [])),
    ]);
    const { facts } = await run(outer, move({ 'in.words': ['a'] }), services);
    expect(facts['out.result']).toEqual({ ok: 'main:a+sub:side' });
    expect(seen.filter(e => e.type === 'stage.entered').map(e => e.name))
      .toEqual(['launcher', 'failover', 'callUpstream']);
  });

  // What a stage provides when it short-circuits and what it provides when it descends are
  // two statements, not one. A resolver that refuses a request it found no upstream for
  // answers with a key its descend path never carries, and that has to be expressible.
  it('lets a stage answer with a key its descend path never carries', async () => {
    const refuses = defineStage<
      Core<'in.words'>, Core<'in.words'>, Core<'out.result'>, Core<'out.result'>,
      Core<'out.result'> & { 'out.refusal': string }
    >({
      name: 'refuses',
      through: {
        request: { needs: ['in.words'], consumes: [], provides: [] },
        response: { needs: ['out.result'], consumes: [], provides: [] },
      },
      return: { provides: ['out.result', 'out.refusal'] },
      execute: async (facts, next) => (facts['in.words'].length === 0
        ? move({ ...facts, 'out.result': { failed: 'nothing to do' }, 'out.refusal': 'empty input' })
        : await next(facts)),
    });
    const pipeline = compose<Core<'in.words'>, Core<'out.result'>>('refusing', [
      refuses, callUpstream(makeProvider('tok', [])),
    ]);
    const refused = await run(pipeline, move({ 'in.words': [] }), PLAIN);
    expect(refused.facts).toMatchObject({ 'out.refusal': 'empty input' });
    const served = await run(pipeline, move({ 'in.words': ['a'], 'route.candidate': 'steady' }), PLAIN);
    expect(served.facts['out.result']).toEqual({ ok: 'tok:a' });
    expect('out.refusal' in served.facts).toBe(false);
  });

  it('runs a stage carrying both traits, one way each time', async () => {
    const attempt = attemptPipeline(makeProvider('tok', []), ['steady']);
    const short = compose<Core<'in.words'>, Core<'out.result'>>('short', [handoffUnlessEmpty(attempt)]);
    const long = compose<Core<'in.words'>, Core<'out.result'>>('long', [handoffUnlessEmpty(attempt)]);
    expect((await run(short, move({ 'in.words': [] }), PLAIN)).facts['out.result']).toEqual({ ok: '' });
    expect((await run(long, move({ 'in.words': ['a', 'b'] }), PLAIN)).facts['out.result']).toEqual({ ok: 'tok:a-b' });
  });

  it('reaches a provider through a sealed handle whose type mentions only the core space', async () => {
    const inside = compose<Core<'in.text'>, Core<'out.result'>>('inside-package', [
      splitWords, handoff(attemptPipeline(makeProvider('tok', []), ['steady'])),
    ]);
    expect((await run(inside, move({ 'in.text': 'a b' }), PLAIN)).facts['out.result']).toEqual({ ok: 'tok:a-b' });
  });

  it('treats a failure as a value the stage above reads, not as a throw', async () => {
    const attempt = attemptPipeline(makeProvider('tok', []), ['flaky']);
    const { facts } = await run(attempt, move({ 'in.words': ['a'] }), PLAIN);
    expect(facts['out.result']).toEqual({ failed: 'flaky refused' });
  });
});
