// Deferral: what a run started and has not finished.
//
// The rule these establish is that a stage has no fire-and-forget. Work a stage begins
// becomes a fact with a name, and teardown is where the run waits for it — so nothing
// escapes the run's own accounting, and nothing hangs it either.

import { describe, expect, it, vi } from 'vitest';

import { compose, defer, defineStage, isDeferred, move, run } from '../src/index.ts';

const ending = (produce: () => unknown) => defineStage<Record<string, never>, { readonly 'x.settled': unknown }>({
  name: 'ending',
  return: { provides: ['x.settled'] },
  execute: async facts => await Promise.resolve(move({ ...facts, 'x.settled': produce() })),
});

const pipelineOf = (produce: () => unknown) => compose('deferring', [ending(produce)]);

describe('a deferred fact', () => {
  it('is a claim on the value, not a promise the runner went looking for', () => {
    expect(isDeferred(Promise.resolve(1))).toBe(false);
    expect(isDeferred(defer(Promise.resolve(1)))).toBe(true);
    expect(isDeferred({ then: () => {} })).toBe(false);
  });

  // Teardown is where the run waits. A caller that drains has waited for everything the run
  // began, which is what lets a stage start work without reaching for a scheduler.
  it('is awaited at teardown, so what a stage started finishes inside the run', async () => {
    let finished = false;
    let release!: () => void;
    const started = new Promise<void>(resolve => { release = resolve; });
    const { drain } = await run(
      pipelineOf(() => defer(started.then(() => { finished = true; }))),
      move({}),
      {},
    );

    // The run has answered and the work has not finished: that is the whole point of it
    // being deferred rather than awaited where it was started.
    expect(finished).toBe(false);
    const torn = drain();
    release();
    await torn;
    expect(finished).toBe(true);
  });

  // A failure that nobody hears about is a row nobody writes and nobody misses.
  it('reports a failure rather than swallowing it', async () => {
    const error = new Error('the write failed');
    const { drain } = await run(
      pipelineOf(() => defer(Promise.reject(error))),
      move({}),
      {},
    );
    await expect(drain()).rejects.toBe(error);
  });

  it('does not fail declared work after an arbitrary wall-clock deadline', async () => {
    vi.useFakeTimers();
    try {
      let finish!: () => void;
      const work = new Promise<void>(resolve => { finish = resolve; });
      const { drain } = await run(pipelineOf(() => defer(work)), move({}), {});
      let completed = false;
      const draining = drain().then(() => { completed = true; });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(completed).toBe(false);
      finish();
      await draining;
      expect(completed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  // Per run, not per root: a discarded branch's facts are private to it and unreachable from
  // the root's record, so a root-level sweep could never see them. Each run tears down its
  // own, and a branch nobody adopted still finishes what it began.
  it('belongs to the run that started it', async () => {
    const finished: string[] = [];
    const gate = (label: string) => {
      let open!: () => void;
      const waited = new Promise<void>(resolve => { open = resolve; });
      return { open, work: () => defer(waited.then(() => { finished.push(label); })) };
    };
    const innerGate = gate('inner');
    const outerGate = gate('outer');
    const inner = await run(pipelineOf(innerGate.work), move({}), {});
    const outer = await run(pipelineOf(outerGate.work), move({}), {});

    // Tearing one run down waits for that run's own work and nothing else's, which is what
    // lets a discarded branch finish what it began without the root reaching into it.
    const innerTorn = inner.drain();
    innerGate.open();
    await innerTorn;
    expect(finished).toEqual(['inner']);

    const outerTorn = outer.drain();
    outerGate.open();
    await outerTorn;
    expect(finished).toEqual(['inner', 'outer']);
  });
});
